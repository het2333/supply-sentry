"use client";

import { uiAlert } from "@/features/localization/ui-dialogs";
import { useUiLanguage } from "@/features/localization/ui-language";
import { translateReadyworkUiText } from "@/features/localization/chinese-ui-localization";

import Image from "next/image";
import { AiSupplierReplyAnalysis } from "@/features/procurement/ai-supplier-reply-analysis";
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { SUPPLIER_CONFIRMATION_PROMISED_DELAY_APPROVAL_DAYS } from "@readywork/procurement-confirmation-contract";
import {
  analyzeSupplierReply,
  buildSupplierReplySuggestionValues,
  type SupplierReplyField,
} from "@readywork/procurement-supplier-reply-contract";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  FileText,
  History,
  Inbox,
  Loader2,
  MoreHorizontal,
  PackageCheck,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Truck,
  Warehouse,
  X,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { poFollowupActionAvailability, poSendActionAvailability, type PoFollowupActionReadiness, type PoSendActionReadiness } from "@/features/procurement/procurement-ui-state";
import { buildEditPurchaseOrderPatch, type EditPurchaseOrderValues } from "@/features/procurement/edit-po-payload";
import { ManufacturingContextPanel } from "@/features/procurement/manufacturing-context-panel";
import { PoContextChat } from "@/features/procurement/po-context-chat";
import { openPoDocumentSnapshot } from "@/features/procurement/po-print-view";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { cn } from "@/lib/utils";
import { READYWORK_PAGE_CONTAINER_CLASS, READYWORK_PAGE_TITLE_CLASS } from "@/features/procurement/visual-tokens";
import { PO_DETAIL_TABS, poDetailNavigationForPurchaseOrderSelection, poDetailTabForKeyboardNavigation, poDetailTabFromNavigationValue, type PoDetailTabId, type PoDetailTabKeyboardKey } from "@/features/procurement/po-detail-navigation";
import {
  buildPoConfirmationBaselineValues,
  buildPoConfirmationClarificationPlan,
  buildPoConfirmationVariancePreview,
  buildPoDetailFulfilmentEvidence,
  buildPoDetailItemRows,
  buildPoDetailShortfallSummary,
  fillBlankPoConfirmationValues,
  poDetailContextRenderState,
  poDetailMatchedSlaRules,
  poDetailShortfallApprovalLabel,
  poDetailStageTimelineRows,
  selectPoConfirmationCommunication,
  sortPoDetailCommunications,
  type PoDetailItemRow,
} from "@/features/procurement/po-detail-view-model";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { useProcurementRealtimeRefresh } from "@/features/procurement/realtime-events";
import type { PurchaseOrderNavigationIntent } from "@/features/procurement/navigation-state";

type Row = Record<string, unknown>;
type QueueGroup = "needs_action" | "running" | "waiting_external" | "exception" | "completed";
type RiskFilter = "all" | "high" | "medium" | "low";
type DetailTab = PoDetailTabId;
type ItemDeliveryFilter = "all" | "delayed" | "ontrack";

type PoDuplicateActionReadiness = {
  ready: boolean;
  code: "ready" | "supplier_missing" | "po_lines_missing";
  message: string;
};

type DuplicatePurchaseOrderTarget = {
  aggregateId: string;
  expectedVersion: number;
  purchaseOrderNumber: string;
  requiredInHouseAt: string;
  supplierName: string;
  lineCount: number;
};

type DuplicatePurchaseOrderForm = DuplicatePurchaseOrderTarget & {
  newPurchaseOrderNumber: string;
  newRequiredInHouseAt: string;
  reason: string;
  idempotencyKey: string;
  error: string | null;
};

type EditPurchaseOrderTarget = {
  aggregateId: string;
  expectedVersion: number;
  supplierId: string;
  supplierName: string;
  supplierEmail: string;
  contactId: string | null;
  requiredInHouseAt: string;
  materialType: "direct" | "indirect";
  stage: string;
  status: string;
  localizeStage?: boolean;
  localizeStatus?: boolean;
  external: boolean;
  lines: Array<{ id: string; itemCode: string; description: string; quantity: number; unit: string; unitPrice: number | null; taxRate: number | null }>;
  baseline: EditPurchaseOrderValues;
  suppliers: Array<{ id: string; name: string; email: string; contacts: Array<{ id: string; name: string }> }>;
  rihdOnly?: boolean;
};

type MarkAtRiskTarget = {
  aggregateId: string;
  expectedVersion: number;
  purchaseOrderNumber: string;
  stage: string;
  currentRisk: string;
  requiredInHouseAt: string;
  ready: boolean;
  readinessMessage: string;
};

type MarkAtRiskForm = MarkAtRiskTarget & {
  riskSeverity: "medium" | "high" | "critical";
  riskCategory: "schedule" | "supplier_response" | "production" | "logistics" | "quality" | "commercial" | "compliance" | "other";
  reason: string;
  recommendedAction: string;
  idempotencyKey: string;
  error: string | null;
  resultId: string | null;
};

type EditPurchaseOrderForm = EditPurchaseOrderTarget & {
  reason: string;
  idempotencyKey: string;
  error: string | null;
  serverVersion: number | null;
};

type CancelPurchaseOrderStatus = "cancelled" | "pending_external" | "failed" | "unknown";

type CancelPurchaseOrderResult = {
  requestId: string;
  status: CancelPurchaseOrderStatus;
  purchaseOrderVersion: number;
  outboxId: string | null;
};

type PersistedPurchaseOrderCancellation = {
  requestId: string;
  state: string;
  sourcePoVersion: number;
  outboxId: string | null;
  idempotencyKey: string;
  reason: string;
};

type CancelPurchaseOrderTarget = {
  aggregateId: string;
  expectedVersion: number;
  purchaseOrderNumber: string;
  sourceSystem: string;
  blockers: string[];
  existingRequest: PersistedPurchaseOrderCancellation | null;
};

type CancelPurchaseOrderForm = CancelPurchaseOrderTarget & {
  reason: string;
  idempotencyKey: string;
  error: string | null;
  result: CancelPurchaseOrderResult | null;
};

type StageTimelineItem = {
  id: string;
  label: string;
  description: string;
  state: "completed" | "active" | "pending" | "blocked";
  enteredAt?: unknown;
  completedAt?: unknown;
  evidenceConfidence?: "exact" | "observed" | "inferred_from_observed_status" | "none";
  observedPoStatus?: string;
  sla?: {
    status?: string;
    dueAt?: unknown;
    graceUntil?: unknown;
    nextFollowupAt?: unknown;
    followupCount?: number;
    policyVersion?: number;
    ruleId?: string | null;
  } | null;
  events?: Row[];
};

type WorkbenchPayload = {
  operations?: {
    tracked?: number;
    running?: number;
    waitingExternal?: number;
    waitingAction?: number;
    exceptions?: number;
    completedLast7Days?: number;
    byStatus?: Record<string, Record<string, number>>;
  };
  documents?: { purchaseOrders?: { items?: Row[]; total?: number } };
  tasks?: { items?: Row[] };
  approvals?: { items?: Row[] };
  executionApprovals?: { items?: Row[] };
  exceptions?: { items?: Row[] };
  portfolio?: { items?: Row[] };
  permissions?: { operate?: boolean; approve?: boolean };
};

type ContextPayload = {
  requestedId?: string;
  objectId?: string;
  root?: Row;
  purchaseOrders?: Row[];
  suppliers?: Row[];
  confirmations?: Row[];
  productionProgress?: Row[];
  shipments?: Row[];
  transportEvents?: Row[];
  receipts?: Row[];
  invoices?: Row[];
  matches?: Row[];
  communications?: Row[];
  activities?: Row[];
  tasks?: Row[];
  approvals?: Row[];
  executionApprovals?: Row[];
  exceptions?: Row[];
  outbox?: Row[];
  quantityProjections?: Row[];
  attachments?: Attachment[];
  linesByDocument?: Record<string, Row[]>;
  stageTimeline?: StageTimelineItem[];
  purchaseOrderCancellation?: PersistedPurchaseOrderCancellation | null;
  poDetail?: {
    supplier?: Row | null;
    supplierProfile?: Row | null;
    items?: { rows?: Row[] };
    documents?: { rows?: Row[]; requirements?: Row[]; kpis?: { total?: number; verified?: number; pending?: number; missing?: number } };
    history?: { events?: Row[] };
    communication?: { messages?: Row[]; relatedThreads?: Row[]; kpis?: { total?: number; inbound?: number; outbound?: number; pendingDrafts?: number } };
  } | null;
  actionReadiness?: { send_po?: PoSendActionReadiness; queue_followup?: PoFollowupActionReadiness; duplicate_po?: PoDuplicateActionReadiness };
};

type Attachment = {
  id?: string;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
  url?: string;
  sourceDocumentId?: string;
  securityStatus?: string;
  processingStatus?: string;
  detectedContentType?: string;
};

type QueueItem = {
  po: Row;
  tasks: Row[];
  approvals: Row[];
  exceptions: Row[];
  group: QueueGroup;
};

type ActionPlan = {
  id: string;
  label: string;
  description: string;
  preserveDescription?: boolean;
  sideEffects: string[];
  tone: "primary" | "warning" | "danger" | "neutral";
  endpoint: string;
  body: Row;
  idempotencyKey: string;
  runtime?: boolean;
  reasonEditable?: boolean;
  expectsOutbox?: boolean;
  successMessage?: string;
  outboxLabels?: { pending: string; blocked: string; failed: string; dispatched: string; unknown: string };
  evidenceForm?: DeliveryEvidenceForm;
  confirmationEvidenceForm?: ConfirmationEvidenceForm;
  productionProgressForm?: ProductionProgressForm;
  transportEventForm?: TransportEventForm;
  ready?: boolean;
  readinessMessage?: string;
  readinessTarget?: PoSendActionReadiness["target"] | PoFollowupActionReadiness["target"];
  requiresReason?: boolean;
  shortfallLines?: Array<{
    poLineId: string;
    label: string;
    uom: string;
    orderedQty: number;
    confirmedQty: number;
    remainderQty: number;
  }>;
};

type ConfirmationEvidenceForm = {
  communications: Array<{ id: string; subject: string; from: string; receivedAt: string; body: string; messageId?: string }>;
  lines: Array<{
    poLineId: string;
    label: string;
    uom: string;
    orderedQty: number;
    poUnitPrice: number | null;
    currency: string;
    requestedAt: string | null;
  }>;
};

type ProductionProgressForm = {
  lines: Array<{ poLineId: string; label: string; uom: string; effectiveQty: number }>;
};

type DeliveryEvidenceLine = {
  poLineId: string;
  label: string;
  uom: string;
  orderedQty: number;
  shippedQty: number;
  receivedQty: number;
  maxQuantity: number;
};

type DeliveryEvidenceForm = {
  kind: "shipment" | "receipt";
  lines: DeliveryEvidenceLine[];
  shipments?: Array<{ id: string; reference: string }>;
};

type TransportEventForm = {
  shipments: Array<{ id: string; reference: string }>;
  route: string;
};

const groupMeta: Record<QueueGroup, { label: string; empty: string; order: number }> = {
  needs_action: { label: "待我处理", empty: "暂无待审批的订单", order: 0 },
  // 真实异常即使尚未创建审批，也必须优先出现在普通执行/等待队列之前。
  // 这样采购员无需滚过大量正常订单才能发现需要人工关注的红色事项。
  exception: { label: "异常", empty: "暂无订单异常", order: 1 },
  running: { label: "正在执行", empty: "暂无正在执行的订单", order: 2 },
  waiting_external: { label: "等待外部", empty: "暂无等待供应商的订单", order: 3 },
  completed: { label: "已完成", empty: "最近没有完成的订单", order: 4 },
};

const statusNames: Record<string, string> = {
  draft: "PO 草稿",
  sent: "已发送",
  awaiting_confirmation: "等待确认",
  confirmed: "已确认",
  rejected: "供应商拒绝",
  in_production: "生产 / 备货中",
  awaiting_shipment: "待发货",
  partially_shipped: "部分发货",
  shipped: "已发货",
  partially_received: "部分收货",
  received: "已收货",
  closed: "已关闭",
  cancelled: "已取消",
  pending: "等待处理",
  processing: "正在派发",
  blocked: "连接器未就绪",
  dispatched: "已送达连接器",
  failed: "执行失败",
  completed: "已完成",
  running: "执行中",
  waiting_external: "等待外部",
  waiting_approval: "等待审批",
  waiting_human: "等待人工",
  open: "待处理",
  assigned: "已分配",
  confirmed_difference: "确认存在差异",
  verified: "已核验",
  active: "有效",
  inactive: "停用",
};

const executionNames: Record<string, string> = {
  "purchase_order.create_draft": "创建 Odoo 采购订单草稿",
  "purchase_order.send": "发送采购订单",
  "purchase_order.followup": "联系供应商",
  "purchase_order.cancel": "取消采购订单",
  "invoice.update": "回写 ERP 应付状态",
};

const asText = (value: unknown, fallback = "—") => typeof value === "string" && value.trim() ? value : fallback;
const duplicatePoIdempotencyKey = (aggregateId: string) => `web-po:duplicate:${aggregateId}:${crypto.randomUUID()}`;
const editPoIdempotencyKey = (aggregateId: string) => `web-po:edit:${aggregateId}:${crypto.randomUUID()}`;
const cancelPoIdempotencyKey = (aggregateId: string) => `web-po:cancel:${aggregateId}:${crypto.randomUUID()}`;
const asNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
const statusName = (value: unknown) => statusNames[String(value ?? "")] ?? asText(value, "待处理");
const compactId = (value: unknown) => {
  const text = asText(value, "");
  return text.length > 24 ? `${text.slice(0, 12)}…${text.slice(-6)}` : text;
};
const money = (value: unknown, currency: unknown) => {
  const number = asNumber(value);
  if (number === undefined) return "—";
  try { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: asText(currency, "CNY") }).format(number); }
  catch { return `${number.toLocaleString("zh-CN")} ${asText(currency, "")}`; }
};
const itemMoney = (value: unknown, currency: string) => {
  const number = asNumber(value);
  return number === undefined ? "—" : `${new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number)} ${currency}`;
};
const itemTaxPercent = (value: unknown) => {
  const number = asNumber(value);
  if (number === undefined) return "—";
  const percentage = Math.abs(number) <= 1 ? number * 100 : number;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(percentage)}%`;
};
const formatBytes = (value?: number) => typeof value === "number" && Number.isFinite(value) && value >= 0
  ? value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`
  : "大小未提供";
const badgeTone = (status: unknown): "red" | "amber" | "blue" | "violet" | "neutral" => {
  const value = String(status ?? "");
  if (["failed", "blocked", "exception", "rejected", "open"].includes(value)) return "red";
  if (["pending", "waiting_approval", "waiting_human", "assigned"].includes(value)) return "violet";
  if (["sent", "awaiting_confirmation", "waiting_external", "partially_shipped", "partially_received"].includes(value)) return "amber";
  if (["completed", "received", "closed", "dispatched", "confirmed"].includes(value)) return "blue";
  return "neutral";
};

function errorMessage(error: unknown): string {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 401) return "登录已过期，请重新登录。";
    if (error.status === 403) return "当前身份没有执行该操作的权限。";
    if (error.status === 408 || error.status === 0) return "连接结果暂时未确认；本次请求编号已保留，可先刷新或安全重试。";
    if (error.status === 409) return "订单版本或状态已变化，已为你重新读取最新事实。";
    if (error.status === 422) return error.message || "当前业务状态不允许该操作。";
  }
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

function purchaseOrderCancellationBlockers(po: Row, detail: ContextPayload | null): string[] {
  const blockers: string[] = [];
  const status = asText(po.status, "").toLowerCase();
  if (["partially_shipped", "shipped", "partially_received", "received", "closed", "cancelled"].includes(status)) {
    blockers.push(`当前状态为 ${statusName(status)}，不允许取消`);
  }
  if ((detail?.shipments?.length ?? 0) > 0) blockers.push("已存在 Shipment / 发运事实");
  if ((detail?.receipts?.length ?? 0) > 0) blockers.push("已存在 Receipt / GRN 收货事实");
  if ((detail?.invoices?.length ?? 0) > 0) blockers.push("已存在关联发票事实");
  if ((detail?.quantityProjections ?? []).some((projection) =>
    [projection.shippedQty, projection.receivedQty, projection.invoicedQty]
      .some((value) => (asNumber(value) ?? 0) > 0))) {
    blockers.push("行级累计发运、收货或开票数量大于 0");
  }
  return [...new Set(blockers)];
}

function cancellationStatusFromPersistedState(state: string): CancelPurchaseOrderStatus {
  if (state === "applied") return "cancelled";
  if (state === "failed" || state === "rejected") return "failed";
  if (state === "unknown") return "unknown";
  return "pending_external";
}

function classify(po: Row, tasks: Row[], approvals: Row[], exceptions: Row[]): QueueGroup {
  if (exceptions.some((item) => ["open", "assigned"].includes(String(item.status ?? ""))) || tasks.some((item) => item.status === "failed") || po.status === "rejected") return "exception";
  if (approvals.length || tasks.some((item) => ["waiting_approval", "waiting_human"].includes(String(item.status ?? "")))) return "needs_action";
  if (tasks.some((item) => ["created", "queued", "running"].includes(String(item.status ?? ""))) || po.status === "draft") return "running";
  if (["sent", "awaiting_confirmation", "confirmed", "in_production", "awaiting_shipment", "partially_shipped", "shipped", "partially_received"].includes(String(po.status ?? ""))) return "waiting_external";
  if (["received", "closed"].includes(String(po.status ?? ""))) return "completed";
  return "running";
}

function currentWork(item: QueueItem): string {
  const exception = item.exceptions.find((entry) => ["open", "assigned"].includes(String(entry.status ?? "")));
  if (exception) return asText(exception.aiJudgment, "正在整理异常上下文");
  if (item.approvals.length) return "已整理证据，等待人工审批";
  const runningTask = item.tasks.find((entry) => ["created", "queued", "running"].includes(String(entry.status ?? "")));
  if (runningTask) return asText(runningTask.waitingReason, asText(runningTask.workflowId, "智能体正在执行"));
  if (item.po.stage === "supplier_commitment") return "已发送 PO，等待供应商完整确认或差异审批";
  if (item.po.stage === "fulfilment_production") return "正在跟踪备货、生产与承诺交期";
  if (item.po.stage === "dispatch_transit" || item.po.stage === "delivery_grn") return "正在跟踪发货、在途与收货累计数量";
  if (item.po.status === "draft") return "PO Draft 已就绪，等待发送";
  return "当前阶段已完成";
}

function nextStep(item: QueueItem): string {
  if (item.group === "exception") return "查看异常建议";
  if (item.group === "needs_action") return "人工审批后续跑";
  if (item.group === "running") return item.po.status === "draft" ? "确认后发送 PO" : "等待执行结果";
  if (item.group === "waiting_external") return asText(item.po.nextAction, item.po.stage === "supplier_commitment" ? "可再次催确认" : "按承诺节点继续跟踪");
  return "查看完整审计";
}

function riskLevel(item: QueueItem): Exclude<RiskFilter, "all"> | "unknown" {
  if (["high", "medium", "low"].includes(String(item.po.risk ?? ""))) return item.po.risk as Exclude<RiskFilter, "all">;
  if (item.group === "exception") return "high";
  if (item.group === "needs_action" || item.group === "waiting_external") return "medium";
  return "unknown";
}

function supplierReplyFieldLabel(field: SupplierReplyField): string {
  return field === "quantity" ? "确认数量" : field === "unit_price" ? "确认单价" : "承诺交期";
}

function ReplySuggestionMetric({
  label,
  value,
  confidence,
}: {
  label: string;
  value: string;
  confidence?: "high" | "medium" | "low";
}) {
  return <div className={cn("min-w-0 rounded-lg border px-3 py-2", confidence === "high" ? "border-blue-100 bg-blue-50/55" : "border-slate-100 bg-slate-50")}>
    <div className="text-[9px] font-medium text-slate-500">{label}</div>
    <div className={cn("mt-1 truncate text-[11px] font-semibold", confidence === "high" ? "text-[#174d9b]" : "text-slate-500")}>{value}</div>
    <div className="mt-1 text-[9px] text-slate-400">{confidence === "high" ? "高置信建议" : confidence === "medium" ? "中置信·需核对" : "等待人工填写"}</div>
  </div>;
}

function SafeAttachment({ attachment }: { attachment: Attachment }) {
  const link = (() => {
    const value = attachment.url?.trim();
    if (!value) return undefined;
    if (value.startsWith("/") && !value.startsWith("//")) return { href: value, inline: true } as const;
    try {
      const parsed = new URL(value);
      return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password
        ? { href: parsed.href, inline: false } as const
        : undefined;
    } catch { return undefined; }
  })();
  const contentType = asText(attachment.detectedContentType, asText(attachment.contentType, "")).toLowerCase();
  const isImage = contentType.startsWith("image/");
  const isPdf = contentType === "application/pdf";
  const scannedClean = attachment.securityStatus === "clean";
  const canInline = Boolean(link?.inline && scannedClean && (isImage || isPdf));
  const status = attachment.securityStatus === "clean"
    ? { label: "ClamAV 已通过", className: "border-emerald-200 bg-emerald-50 text-emerald-700" }
    : attachment.securityStatus === "quarantined"
      ? { label: "已隔离", className: "border-red-200 bg-red-50 text-red-700" }
      : attachment.securityStatus === "pending_scan"
        ? { label: "等待扫描", className: "border-amber-200 bg-amber-50 text-amber-700" }
        : undefined;
  const emptyMessage = attachment.securityStatus === "quarantined"
    ? "附件未通过安全检查，已禁止打开与预览。"
    : attachment.securityStatus === "pending_scan"
      ? "ClamAV 明确通过前不会加载文件内容。"
      : !attachment.url
        ? "当前只有附件事实，没有可访问的真实文件地址。"
        : !link
          ? "附件 URL 不安全，已阻止打开。"
          : !link.inline
            ? "外部附件不会自动加载；请显式安全打开。"
            : !scannedClean
              ? "未提供可验证的恶意软件扫描结果，已停止自动预览。"
              : "该附件类型不支持内嵌预览，可在新窗口安全打开。";
  return <div className="overflow-hidden rounded-xl border border-[#dfe6ef] bg-white">
    <div className="flex flex-wrap items-center gap-3 px-3 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#f1f5f9]"><FileText className="size-4 text-[#64748b]" /></span>
      <div className="min-w-0 flex-1"><div data-preserve-language={hasDataText(attachment.fileName) ? true : undefined} className="truncate text-xs font-semibold text-[#26364f]">{asText(attachment.fileName, "未命名附件")}</div><div className="mt-1 text-[11px] text-[#8795a8]">{asText(attachment.detectedContentType, asText(attachment.contentType, "类型未知"))} · {formatBytes(attachment.sizeBytes)}</div></div>
      {status ? <span className={cn("rounded-full border px-2.5 py-1 text-[10px] font-semibold", status.className)}>{status.label}</span> : null}
      {link && (!link.inline || (scannedClean && !isImage && !isPdf)) ? <a href={link.href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-xs font-semibold text-[#17634f] hover:underline">安全打开</a> : null}
    </div>
    {canInline && isImage ? <div className="border-t border-[#edf1f6] bg-[#f8fafc] p-3"><Image data-preserve-language={hasDataText(attachment.fileName) ? true : undefined} src={link!.href} alt={asText(attachment.fileName, "附件预览")} width={1200} height={800} unoptimized referrerPolicy="no-referrer" className="max-h-[420px] w-full rounded-lg object-contain" /></div>
      : canInline && isPdf ? <div className="border-t border-[#edf1f6] bg-[#f8fafc] p-3"><iframe data-preserve-language={hasDataText(attachment.fileName) ? true : undefined} title={asText(attachment.fileName, "PDF 附件")} src={link!.href} sandbox="allow-same-origin" referrerPolicy="no-referrer" className="h-[460px] w-full rounded-lg border border-[#dfe6ef] bg-white" /></div>
        : <div className="border-t border-[#edf1f6] bg-[#f8fafc] px-3 py-2.5 text-[11px] leading-5 text-[#718198]">{emptyMessage}</div>}
  </div>;
}

function timelineEvents(detail: ContextPayload | null) {
  const activities = (detail?.activities ?? []).map((item, index) => ({ id: asText(item.id, `activity:${index}`), at: item.at, title: asText(item.summary, asText(item.action, "业务活动")), preserveTitle: hasDataText(item.summary) || hasDataText(item.action), preserveMeta: true, meta: `${asText(item.actor, "—")} · ${asText(item.action, "activity")}`, state: "activity", type: asText(item.action, ""), source: "activity" }));
  const outbox = (detail?.outbox ?? []).map((item, index) => ({ id: asText(item.id, `outbox:${index}`), at: item.dispatchedAt ?? item.failedAt ?? item.updatedAt ?? item.createdAt, title: executionNames[asText(item.action, "")] ?? asText(item.action, "连接器执行"), preserveTitle: !executionNames[asText(item.action, "")] && hasDataText(item.action), meta: <><TextValue value={item.channel} fallback="connector" /> · <StatusValue value={item.status} /> · 尝试 {asNumber(item.attempts) ?? 0} 次</>, state: asText(item.status, "pending"), type: asText(item.action, ""), source: "outbox" }));
  const communications = (detail?.communications ?? []).map((item, index) => ({ id: asText(item.id, `communication:${index}`), at: item.receivedAt ?? item.occurredAt ?? item.createdAt, title: <>{item.direction === "inbound" ? "收到供应商消息：" : "已生成外发消息："}<TextValue value={item.subject} fallback="无主题" /></>, preserveTitle: false, meta: <><TextValue value={item.channel} fallback="email" /> · <TextValue value={hasDataText(item.from) ? item.from : item.to} fallback="通信记录" /></>, state: item.direction === "inbound" ? "received" : "sent", type: "communication", source: "communication" }));
  const progressLabels: Record<string, string> = { materials_ready: "物料已齐备", in_production: "生产中", quality_check: "质量检验", ready_to_ship: "待发运", delayed: "生产延期", blocked: "生产受阻" };
  const productionProgress = (detail?.productionProgress ?? []).map((item, index) => ({ id: asText(item.id, `production-progress:${index}`), at: item.reportedAt ?? item.createdAt, title: progressLabels[asText(item.overallStatus, "")] ?? "生产 / 备货进度", preserveTitle: false, meta: <><TextValue value={item.externalId} fallback="证据编号未记录" /> · <TextValue value={item.evidenceSource} fallback="来源未记录" /></>, state: ["delayed", "blocked"].includes(asText(item.overallStatus, "")) ? "failed" : "completed", type: "production_progress", source: "production_progress" }));
  const transportLabels: Record<string, string> = { picked_up: "承运商已揽收", departed_origin: "已离开发运地", arrived_port: "已抵达口岸", customs_submitted: "已提交清关", customs_cleared: "已完成清关", customs_held: "清关受阻", out_for_delivery: "正在派送", delivered: "承运商已送达", exception: "运输异常" };
  const transportEvents = (detail?.transportEvents ?? []).map((item, index) => ({ id: asText(item.id, `transport-event:${index}`), at: item.occurredAt ?? item.createdAt, title: transportLabels[asText(item.eventCode, "")] ?? "运输节点", preserveTitle: false, meta: <><TextValue value={item.location} fallback="位置未提供" /> · <TextValue value={item.externalId} fallback="证据编号未记录" /></>, state: ["customs_held", "exception"].includes(asText(item.eventCode, "")) ? "failed" : "completed", type: "transport_event", source: "transport_event" }));
  return [...activities, ...outbox, ...communications, ...productionProgress, ...transportEvents].sort((left, right) => String(right.at ?? "").localeCompare(String(left.at ?? "")));
}

const stageStateMeta = {
  completed: { label: "已完成", badge: "bg-[#dcfce7] text-[#14804a]", node: "border-[#2176ff] bg-[#2176ff] text-white" },
  active: { label: "进行中", badge: "bg-[#e8f1ff] text-[#1764d8]", node: "border-[#2176ff] bg-white text-[#2176ff]" },
  pending: { label: "待处理", badge: "bg-[#f1f5f9] text-[#64748b]", node: "border-[#dce4ec] bg-white text-[#cbd5e1]" },
  blocked: { label: "已阻断", badge: "bg-red-50 text-red-600", node: "border-red-500 bg-red-50 text-red-500" },
} as const;

function slaStatusLabel(status: string | undefined): string {
  return ({ on_track: "SLA 正常", due_soon: "即将到期", in_grace: "宽限期", breached: "SLA 已超时", escalated: "已升级", blocked_missing_evidence: "缺少期限证据", unmatched: "未匹配规则" } as Record<string, string>)[status ?? ""] ?? "未评估";
}

const stageLabels: Record<string, string> = { po_sent: "采购订单发送", supplier_commitment: "供应商承诺", fulfilment_production: "履约 / 生产", dispatch_transit: "发运 / 在途", delivery_grn: "交付 / 收货" };
function stageDisplayLabel(stage: Pick<StageTimelineItem, "id" | "label"> | undefined): string {
  return stage ? stageLabels[stage.id] ?? asText(stage.label) : "—";
}
function StageLabel({ stage }: { stage: Pick<StageTimelineItem, "id" | "label"> | undefined }) {
  return <span data-preserve-language={stage && !stageLabels[stage.id] ? true : undefined}>{stageDisplayLabel(stage)}</span>;
}
const hasDataText = (value: unknown) => typeof value === "string" && value.trim().length > 0;
// Only the source value is business data; an absent-value label is interface copy.
function TextValue({ value, fallback = "—" }: { value: unknown; fallback?: string }) {
  return <span data-preserve-language={hasDataText(value) ? true : undefined}>{asText(value, fallback)}</span>;
}
function StatusValue({ value }: { value: unknown }) {
  return <span data-preserve-language={statusNames[asText(value, "")] ? undefined : true}>{statusName(value)}</span>;
}

function StageTimeline({ stages, showEvidence = true, compact = false }: { stages: StageTimelineItem[]; showEvidence?: boolean; compact?: boolean }) {
  const { formatShortDateTime } = useProcurementLocale();
  const formatTime = (value: unknown) => formatShortDateTime(typeof value === "string" ? value : null, "时间未记录");
  if (!stages.length) return <div className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-xs leading-5 text-slate-400">当前订单没有可验证的阶段事实。页面不会根据名称或演示数据猜测进度。</div>;
  const rows = poDetailStageTimelineRows(stages);
  return <div data-testid="po-stage-timeline" aria-label="采购订单五阶段时间线" className={compact ? "min-w-0" : "rounded-[18px] border border-[#e3e9f1] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]"}>
    {!compact ? <div className="mb-7"><div className="text-[18px] font-semibold tracking-[-0.02em] text-[#13203a]">时间线</div>{showEvidence ? <p className="mt-1 text-[11px] leading-5 text-[#718198]">五阶段均来自持久化业务事实。</p> : null}</div> : null}
    <div>{rows.map((stage) => {
      const meta = stageStateMeta[stage.state];
      const at = stage.completedAt ?? stage.enteredAt;
      const stageTime = at ? formatTime(at) : stage.state === "completed" ? "历史时间未记录" : "尚未发生";
      const evidenceText = stage.evidenceConfidence === "exact" ? "精确业务事件" : stage.evidenceConfidence === "observed" ? "ERP / 数据状态观察" : stage.evidenceConfidence === "inferred_from_observed_status" ? "由已观察状态推导" : "尚无证据";
      return <div key={stage.id} data-stage-id={stage.id} data-stage-state={stage.state} className={cn("grid grid-cols-[34px_minmax(0,1fr)]", compact ? "gap-x-2" : "gap-x-4")}>
        <div className="relative flex justify-center"><span className={cn("relative z-10 flex size-8 items-center justify-center rounded-full border-2", meta.node)}>{stage.state === "completed" ? <Check className="size-4 stroke-[3]" /> : stage.state === "blocked" ? <X className="size-4 stroke-[3]" /> : stage.state === "active" ? <span className="size-2.5 rounded-full bg-[#2176ff]" /> : <span className="size-2 rounded-full bg-[#e2e8f0]" />}</span>{stage.connector !== "none" ? <span className={cn("absolute bottom-0 top-8 w-0.5", stage.connector === "completed" ? "bg-[#2176ff]" : "bg-[#e5eaf0]")} /> : null}</div>
        <div className={cn("min-w-0", compact ? "pb-4" : "pb-8")}>
          <div className={cn("font-semibold leading-5 text-[#14213a]", compact ? "text-xs" : "text-[15px]")}><StageLabel stage={stage} /></div>
          <span className={cn("mt-2 inline-flex rounded-full px-3 py-1 text-[10px] font-semibold", meta.badge)}>{meta.label}</span>
          {!compact ? <p data-preserve-language={stageLabels[stage.id] ? undefined : true} className="mt-2.5 text-[12px] leading-5 text-[#718198]">{stage.description}</p> : null}
          {showEvidence ? <details className="group mt-3 rounded-xl bg-[#f7f9fc] px-3 py-2.5 text-[10px] leading-4 text-[#62738d]">
            <summary className="cursor-pointer list-none font-semibold text-[#52627a] marker:hidden">查看阶段证据与 SLA <ChevronRight className="ml-1 inline size-3 transition group-open:rotate-90" /></summary>
            <div className="mt-3 grid gap-2 border-t border-[#e7ecf2] pt-3">
              {compact ? <p data-preserve-language={stageLabels[stage.id] ? undefined : true}>{stage.description}</p> : null}
              <span>阶段时间：<b className="font-medium text-[#34445d]">{stageTime}</b></span>
              <span>证据：<b className="font-medium text-[#34445d]">{evidenceText}</b></span>
              {stage.sla ? <><span>期限：<b className="font-medium text-[#34445d]">{stage.sla.dueAt ? formatTime(stage.sla.dueAt) : "未建立"}</b></span><span>状态：<b className={cn("font-medium", ["breached", "escalated"].includes(stage.sla.status ?? "") ? "text-red-600" : "text-[#34445d]")}>{slaStatusLabel(stage.sla.status)}</b></span>{stage.sla.graceUntil ? <span>宽限截至：<b className="font-medium text-[#34445d]">{formatTime(stage.sla.graceUntil)}</b> · 已跟进 {stage.sla.followupCount ?? 0} 次</span> : null}</> : stage.state === "active" ? <span className="text-amber-700">尚无已发布 SLA 评估，未生成期限或宽限期。</span> : null}
              {stage.events?.length ? <span>{stage.events.length} 条不可变阶段事件 · 最近来源 {asText(stage.events.at(-1)?.sourceKind, "未知")}</span> : null}
            </div>
          </details> : null}
        </div>
      </div>;
    })}</div>
  </div>;
}

const poTabCardClass = "rounded-[24px] border border-[#e3e8ef] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.025)]";

const documentCategoryLabels: Record<string, string> = { purchase_order: "采购订单", supplier_confirmation: "供应商确认", packing_list: "装箱单", invoice: "发票", contract: "合同", attachment: "附件", download: "下载快照", print: "打印快照", uncategorized: "未分类" };
function documentCategoryLabel(value: unknown, fallback?: string): string {
  const key = asText(value, "");
  const knownLabel = documentCategoryLabels[key];
  const fallbackLabel = asText(fallback, "");
  return knownLabel ?? (fallbackLabel || key || "—");
}

function documentOpenHref(value: unknown): string | null {
  const href = asText(value, "");
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  try {
    // Browsers normalize /\\host to a protocol-relative URL; a prefix check alone is insufficient.
    return new URL(href, "https://readywork.invalid").origin === "https://readywork.invalid" ? href : null;
  } catch { return null; }
}

function documentStatusView(document: Row): { label: string; tone: "green" | "amber" | "red" | "neutral" } {
  if (document.status === "missing") return { label: "缺失", tone: "red" };
  if (document.verified === true) return { label: "已核验", tone: "green" };
  if (document.verified === false || ["pending", "under_review", "security_blocked", "expired"].includes(asText(document.status, ""))) {
    return { label: "待审核", tone: "amber" };
  }
  const raw = asText(document.status, "");
  if (raw === "verified") return { label: "—", tone: "neutral" };
  return { label: raw || "—", tone: "neutral" };
}

function PoTabMetrics({ title, values }: { title: string; values: Array<{ label: string; value: string | number | null | undefined; caption?: string; localizeValue?: boolean }> }) {
  const icons = [FileText, PackageCheck, Clock3, ShieldCheck];
  const tones = ["bg-[#e8f1ff] text-[#2f6fec]", "bg-[#efeaff] text-[#7958e8]", "bg-[#ffe7e5] text-[#e75b55]", "bg-[#ffe5e7] text-[#df4f58]"];
  return <section aria-label={title} className={cn("grid gap-4 md:grid-cols-2", values.length === 3 ? "xl:grid-cols-3" : "xl:grid-cols-4")}>
    {values.map((metric, index) => {
      const Icon = icons[index % icons.length]!;
      return <article key={metric.label} data-po-kpi className={cn(poTabCardClass, "flex min-h-[108px] items-center gap-4 px-5 py-4")}>
        <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-2xl", tones[index % tones.length])}><Icon className="size-5" /></span>
        <span className="min-w-0"><span className="block text-[11px] font-medium text-[#778398]">{metric.label}</span><span data-preserve-language={metric.localizeValue ? undefined : true} className="mt-1 block truncate text-[21px] font-bold leading-6 tracking-[-0.025em] text-[#101827]">{metric.value ?? "—"}</span>{metric.caption ? <span className="mt-1 block truncate text-[10px] text-[#8792a5]">{metric.caption}</span> : null}</span>
      </article>;
    })}
  </section>;
}

const poItemSummaryColors = ["#3b82f6", "#8b5cf6", "#f59e0b", "#16a34a", "#94a3b8", "#ef4444", "#0ea5e9", "#a855f7"];

type PoItemSummaryBucket = {
  key: string;
  source?: string;
  isFallback: boolean;
  label: string;
  count: number;
  percent: number;
  color: string;
};

function poItemSummaryBuckets(
  items: readonly PoDetailItemRow[],
  value: (item: PoDetailItemRow) => string | undefined,
  label: (value: string) => string = (source) => source,
): PoItemSummaryBucket[] {
  const counts = new Map<string | undefined, number>();
  for (const item of items) {
    const key = value(item)?.trim() || undefined;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const denominator = items.length || 1;
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([key, count], index) => ({
      key: key === undefined ? "missing" : `value:${key}`,
      source: key,
      isFallback: key === undefined,
      label: key === undefined ? "未分类" : label(key),
      count,
      percent: Math.round(count / denominator * 1_000) / 10,
      color: poItemSummaryColors[index % poItemSummaryColors.length]!,
    }));
}

function poItemDonutBackground(buckets: readonly PoItemSummaryBucket[]): string {
  let cursor = 0;
  const segments = buckets.map((bucket) => {
    const start = cursor;
    cursor += bucket.percent;
    return `${bucket.color} ${start}% ${cursor}%`;
  });
  return `conic-gradient(${segments.join(", ")})`;
}

function PoItemPagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  const pages: Array<number | "ellipsis"> = totalPages <= 7
    ? Array.from({ length: totalPages }, (_, index) => index + 1)
    : [1, ...(page > 3 ? ["ellipsis" as const] : []), ...Array.from({ length: Math.max(0, Math.min(totalPages - 1, page + 1) - Math.max(2, page - 1) + 1) }, (_, index) => Math.max(2, page - 1) + index), ...(page < totalPages - 2 ? ["ellipsis" as const] : []), totalPages];
  const buttonClass = "relative flex h-8 min-w-8 items-center justify-center rounded-lg border border-slate-200 bg-white px-2.5 text-[13px] font-medium text-slate-600 transition hover:bg-slate-50 disabled:pointer-events-none disabled:opacity-40";
  return <nav aria-label="行项目分页" className="flex items-center gap-1">
    <button type="button" aria-label="上一页" disabled={page <= 1} onClick={() => onChange(page - 1)} className={buttonClass}><ChevronLeft className="size-4" /><span className="sr-only">上一页</span></button>
    {pages.map((value, index) => value === "ellipsis"
      ? <span key={`ellipsis-${index}`} className="px-1.5 text-sm text-slate-400">…</span>
      : <button key={value} type="button" aria-label={`第 ${value} 页`} aria-current={value === page ? "page" : undefined} onClick={() => onChange(value)} className={cn(buttonClass, value === page && "border-blue-600 bg-blue-600 text-white hover:bg-blue-600")}>{value}</button>)}
    <button type="button" aria-label="下一页" disabled={page >= totalPages} onClick={() => onChange(page + 1)} className={buttonClass}><ChevronRight className="size-4" /><span className="sr-only">下一页</span></button>
  </nav>;
}

function PoItemSummaryPanels({ items }: { items: readonly PoDetailItemRow[] }) {
  const categories = poItemSummaryBuckets(items, (item) => item.category);
  const statuses = poItemSummaryBuckets(items, (item) => item.status, statusName);
  return <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
    <section className={cn(poTabCardClass, "p-6")}>
      <h3 className="text-[15px] font-semibold text-[#13203a]">分类汇总</h3>
      <div className="mt-2 flex items-center gap-6">
        <div role="img" aria-label={`行项目分类占比，共 ${items.length} 项`} className="relative size-[160px] shrink-0 rounded-full" style={{ background: poItemDonutBackground(categories) }}>
          <span className="absolute inset-3 rounded-full bg-white" />
          <span className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="text-[20px] font-bold text-[#101827]">{items.length}</span><span className="text-[11px] text-slate-400">项</span></span>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">{categories.map((bucket) => <div key={bucket.key} className="flex items-center justify-between gap-3 text-[13px]"><span className="flex min-w-0 items-center gap-2.5"><span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: bucket.color }} /><span data-preserve-language={bucket.isFallback ? undefined : true} className="truncate font-medium text-slate-700">{bucket.label}</span></span><span className="shrink-0 text-slate-400"><span className="font-semibold text-slate-800">{bucket.count} 项</span> {bucket.percent}%</span></div>)}</div>
      </div>
    </section>
    <section className={cn(poTabCardClass, "p-6")}>
      <h3 className="text-[15px] font-semibold text-[#13203a]">按状态统计</h3>
      <div className="mt-4 space-y-4">{statuses.map((bucket) => <div key={bucket.key}><div className="mb-1.5 flex items-center justify-between gap-3 text-[13px]"><span data-preserve-language={bucket.isFallback || (bucket.source && statusNames[bucket.source]) ? undefined : true} className="font-medium text-slate-700">{bucket.label}</span><span className="shrink-0 text-slate-400"><span className="font-semibold text-slate-800">{bucket.count} 项</span> ({bucket.percent}%)</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full" style={{ width: `${bucket.percent}%`, backgroundColor: bucket.color }} /></div></div>)}</div>
    </section>
  </div>;
}

function Fact({ label, value, mono = false, localize = false }: { label: string; value: unknown; mono?: boolean; localize?: boolean }) {
  return <div><div className="text-[11px] text-slate-400">{label}</div><div data-preserve-language={localize ? undefined : true} className={cn("mt-1 break-words text-xs font-medium text-slate-800", mono && "font-mono")}>{typeof value === "number" && Number.isFinite(value) ? value : asText(value)}</div></div>;
}

function formatVariance(value: unknown, suffix = ""): string {
  const number = asNumber(value);
  if (number === undefined) return "—";
  return `${number > 0 ? "+" : ""}${number}${suffix}`;
}

function purchaseOrderPageStatus(value: unknown): string {
  const source = asText(value, "");
  if (!source) return "—";
  return statusName(source);
}

function PurchaseOrderPageOverview({
  item,
  po,
  detail,
  supplier,
  supplierProfile,
  poDisplayNumber,
  itemRows,
  risk,
  currentStage,
  actions,
  canApprove,
  formatDate,
  formatMoney,
  onAction,
  onOpenDocuments,
  onResolveReadiness,
}: {
  item: QueueItem;
  po: Row;
  detail: ContextPayload | null;
  supplier: Row | null | undefined;
  supplierProfile: Row | null | undefined;
  poDisplayNumber: string;
  itemRows: ReturnType<typeof buildPoDetailItemRows>;
  risk: "high" | "medium" | "low" | "unknown";
  currentStage: StageTimelineItem | undefined;
  actions: ActionPlan[];
  canApprove: boolean;
  formatDate: (value: unknown) => string;
  formatMoney: (value: unknown, currency: unknown) => string;
  onAction: (action: ActionPlan) => void;
  onOpenDocuments: () => void;
  onResolveReadiness: (target: NonNullable<ActionPlan["readinessTarget"]>) => void;
}) {
  const riskFactors = rows(item.po.riskFactors).sort((left, right) => (asNumber(right.score) ?? 0) - (asNumber(left.score) ?? 0));
  const primaryRisk = riskFactors[0];
  const riskLabel = risk === "high" ? "高" : risk === "medium" ? "中" : risk === "low" ? "低" : "—";
  const requiredInHouseAt = po.requiredInHouseAt ?? item.po.requiredInHouseAt ?? itemRows[0]?.requestedAt;
  const currency = po.currency ?? item.po.currency;
  const amountTotal = item.po.amountTotal ?? po.amountTotal;
  const stages = detail?.stageTimeline ?? [];
  const completedStages = stages.filter((stage) => stage.state === "completed").length;
  const progress = stages.length ? Math.round(completedStages / stages.length * 100) : null;
  const reminderAction = actions.find((action) => action.id === "followup-confirm");
  const pendingApproval = detail?.executionApprovals?.find((entry) => entry.status === "pending" && entry.kind === "supplier_confirmation");
  const pendingConfirmation = pendingApproval ? detail?.confirmations?.find((entry) => entry.id === pendingApproval.objectId) : undefined;
  const pendingLines = pendingConfirmation ? detail?.linesByDocument?.[asText(pendingConfirmation.id, "")] ?? rows(pendingConfirmation.lines) : [];
  const poLines = detail?.linesByDocument?.[asText(po.id, "")] ?? rows(po.lines);
  // Show the facts from this approval's confirmation, not a different/latest
  // confirmation or the already-accepted quantity projection.
  const approvalRows = buildPoDetailItemRows({ po, lines: poLines, quantityProjections: [], confirmationLines: pendingLines })
    .filter((line) => pendingLines.some((entry) => entry.poLineId === line.id));
  const approvalActions = actions.filter((action) => action.id === "approve-confirmation" || action.id === "reject-confirmation");
  const pendingRuntimeApproval = detail?.approvals?.find((entry) => !entry.status || entry.status === "pending");
  const workflowActions = actions.filter((action) => !["approve-confirmation", "reject-confirmation", "followup-confirm"].includes(action.id));
  const shortfallRows = approvalRows.filter((line) => (line.remainderQty ?? 0) > 0);
  const supplierContacts = rows(supplier?.contacts);
  const contact = supplierContacts.find((entry) => entry.primary === true) ?? supplierContacts[0];
  const attachments = detail?.attachments ?? [];
  const detailRows: Array<[string, unknown, string, unknown]> = [
    ["订单编号", poDisplayNumber, "装运港", po.portOfLoading],
    ["供应商", supplier?.name ?? po.supplierName ?? po.supplierId, "卸货港", po.portOfDischarge],
    ["联系人", contact?.name, "原产国", po.countryOfOrigin ?? po.originCountry],
    ["订单日期", po.orderedAt, "运输方式", po.modeOfTransport ?? po.transportMode],
    ["币种", currency, "发送日期", po.sentAt],
    ["国际贸易术语", po.incotermName ?? po.incoterm, "状态", purchaseOrderPageStatus(po.status)],
    ["付款条款", po.paymentTerms ?? supplierProfile?.paymentTerms, "", ""],
  ];
  const pageDate = (value: unknown) => typeof value === "string" && value.trim() ? formatDate(value) : "—";
  const cardClass = "rounded-[24px] border border-[#e3e8ef] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.025)]";
  const metricRows = [
    { label: "订单金额", value: formatMoney(amountTotal, currency), caption: "订单总金额", icon: <FileText className="size-5" />, tone: "bg-[#e8f1ff] text-[#2f6fec]" },
    { label: "行项目总数", value: String(itemRows.length), caption: `以 ${asText(currency)} 计价`, icon: <PackageCheck className="size-5" />, tone: "bg-[#efeaff] text-[#7958e8]" },
    { label: "要求到厂日期", value: pageDate(requiredInHouseAt), caption: (asNumber(item.po.overdueDays) ?? 0) > 0 ? `已逾期 ${asNumber(item.po.overdueDays)} 天` : "按计划进行", icon: <AlertTriangle className="size-5" />, tone: "bg-[#ffe7e5] text-[#e75b55]" },
    { label: "风险等级", value: riskLabel, caption: asText(primaryRisk?.label), preserveCaption: true, icon: <ShieldCheck className="size-5" />, tone: "bg-[#ffe5e7] text-[#df4f58]" },
  ];

  return <div className="space-y-6">
    {pendingApproval ? <section aria-label="待审批" className="rounded-[24px] border border-amber-300 bg-amber-50 p-5 sm:p-6">
      <div className="flex items-center gap-2 text-[15px] font-semibold text-amber-950"><ShieldCheck className="size-5 shrink-0" /><h3>供应商确认待审批</h3></div>
      <p className="mt-2 text-sm leading-6 text-amber-900">{asText(pendingApproval.reason, "供应商确认存在差异，需要人工决策。")}</p>
      <p className="mt-1 text-xs leading-5 text-amber-800">以下为供应商回复的待审内容，尚未批准。请核对后选择批准或拒绝；点击按钮后会再次确认。</p>
      {approvalRows.length ? <div className="mt-4 overflow-x-auto rounded-xl border border-amber-200 bg-white">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="bg-amber-100/60 text-amber-900"><tr><th className="px-4 py-3">物料</th><th className="px-4 py-3">数量（原订单 → 供应商）</th><th className="px-4 py-3">单价（原订单 → 供应商）</th><th className="px-4 py-3">交期（原订单 → 供应商）</th></tr></thead>
          <tbody>{approvalRows.map((line) => {
            const confirmedLine = pendingLines.find((entry) => entry.poLineId === line.id);
            return <tr key={line.id} className="border-t border-amber-100 text-slate-700">
              <th scope="row" className="max-w-[280px] px-4 py-3 font-medium leading-5"><span data-preserve-language={"labelIsFallback" in line && line.labelIsFallback ? undefined : true}>{line.label}</span></th>
              <td className="whitespace-nowrap px-4 py-3">{line.orderedQty ?? "—"} <span data-preserve-language>{line.uom}</span> → <strong>{line.confirmedQty ?? "—"} <span data-preserve-language>{line.uom}</span></strong></td>
              <td className="whitespace-nowrap px-4 py-3">{formatMoney(line.unitPrice, line.currency)} → <strong>{formatMoney(confirmedLine?.confirmedUnitPrice, line.currency)}</strong></td>
              <td className="whitespace-nowrap px-4 py-3">{pageDate(line.requestedAt)} → <strong>{pageDate(line.confirmedPromisedAt)}</strong></td>
            </tr>;
          })}</tbody>
        </table>
      </div> : null}
      {shortfallRows.length ? <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-800">
        <p className="font-semibold">这不是部分发货：批准短交后，剩余量将永久关闭。</p>
        <ul className="mt-2 space-y-1">{shortfallRows.map((line) => <li key={line.id}><span data-preserve-language={"labelIsFallback" in line && line.labelIsFallback ? undefined : true}>{line.label}</span>：将关闭剩余 {line.remainderQty} <span data-preserve-language>{line.uom}</span>。</li>)}</ul>
        <p className="mt-2">如仍需后续交付，请先继续沟通，不要批准关闭剩余量。批准时必须填写原因。</p>
      </div> : null}
      {canApprove ? <div className="mt-4 flex flex-wrap items-center gap-3">{approvalActions.map((action) => <button id={`po-ai-action-${action.id}`} key={action.id} type="button" disabled={action.ready === false} onClick={() => onAction(action)} className={cn("min-h-11 rounded-xl px-4 py-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45", action.tone === "danger" ? "border border-red-200 bg-white text-red-700 hover:bg-red-50" : "bg-[#3569df] text-white hover:bg-[#285bc1]")}>{action.label}</button>)}{!approvalActions.length ? <p className="text-xs text-amber-900">审批操作尚未就绪，请刷新订单上下文后重试。</p> : null}</div> : <p className="mt-4 text-sm font-medium text-amber-950">当前账号没有审批权限，请由有审批权限的负责人处理。</p>}
    </section> : null}
    {pendingRuntimeApproval ? <section aria-label="运行审批" className="rounded-[24px] border border-amber-300 bg-amber-50 p-5 sm:p-6">
      <h3 className="flex items-center gap-2 text-[15px] font-semibold text-amber-950"><ShieldCheck className="size-5" />智能体执行待审批</h3>
      <p className="mt-2 text-sm leading-6 text-amber-900"><TextValue value={pendingRuntimeApproval.message} fallback="当前执行已暂停，等待负责人核验。" /></p>
      {!canApprove ? <p className="mt-3 text-sm font-medium text-amber-950">当前账号没有审批权限，请由有审批权限的负责人处理。</p> : !detail?.tasks?.some((task) => task.id === pendingRuntimeApproval.taskId) ? <p className="mt-3 text-sm font-medium text-amber-950">审批关联任务尚未读回，暂不开放业务操作。请刷新订单上下文后重试。</p> : null}
    </section> : null}
    <section aria-label="采购订单指标" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {metricRows.map((metric) => <article key={metric.label} data-po-kpi className={cn(cardClass, "flex min-h-[108px] items-center gap-4 px-5 py-4")}>
        <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-2xl", metric.tone)}>{metric.icon}</span>
        <span className="min-w-0"><span className="block text-[11px] font-medium text-[#778398]">{metric.label}</span><span className="mt-1 block truncate text-[21px] font-bold leading-6 tracking-[-0.025em] text-[#101827]">{metric.value}</span><span data-preserve-language={metric.preserveCaption ? true : undefined} className={cn("mt-1 block truncate text-[10px]", metric.label === "要求到厂日期" && (asNumber(item.po.overdueDays) ?? 0) > 0 ? "font-medium text-[#d64e4e]" : "text-[#8792a5]")}>{metric.caption}</span></span>
      </article>)}
    </section>

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-5">
        <section className={cn(cardClass, "min-h-[388px] p-6")}>
          <h3 className="text-[15px] font-semibold text-[#101827]">采购订单详情</h3>
          <div className="mt-4 divide-y divide-[#eef1f5]">
            {detailRows.map(([leftLabel, leftValue, rightLabel, rightValue]) => <div key={leftLabel} className="grid gap-x-8 gap-y-3 py-3 text-[12px] first:pt-0 last:pb-0 md:grid-cols-2">
              <div className="grid grid-cols-[138px_minmax(0,1fr)] gap-3"><span className="text-[#7d889a]">{leftLabel}</span><span data-preserve-language className={cn("font-medium text-[#202a3a]", leftLabel === "供应商" && "text-[#3569df]")}>{leftLabel.includes("日期") ? pageDate(leftValue) : asText(leftValue)}</span></div>
              {rightLabel ? <div className="grid grid-cols-[138px_minmax(0,1fr)] gap-3"><span className="text-[#7d889a]">{rightLabel}</span><span data-preserve-language={rightLabel === "状态" && !!statusNames[asText(po.status, "")] ? undefined : true} className="font-medium text-[#202a3a]">{rightLabel.includes("日期") ? pageDate(rightValue) : asText(rightValue)}</span></div> : null}
            </div>)}
          </div>
        </section>

        <div className="grid items-start gap-5 md:grid-cols-2">
          <section className={cn(cardClass, "p-6")}>
            <h3 className="text-[15px] font-semibold text-[#101827]">时间线</h3>
            {stages.length ? <div className="mt-5 space-y-0">{poDetailStageTimelineRows(stages).map((stage) => <div key={stage.id} className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 pb-5 last:pb-0"><span className={cn("mt-0.5 flex size-5 items-center justify-center rounded-full border", stage.state === "completed" ? "border-[#326eea] bg-[#326eea] text-white" : stage.state === "active" ? "border-[#326eea] bg-white text-[#326eea]" : "border-[#d9e0ea] bg-white text-[#aeb8c8]")}>{stage.state === "completed" ? <Check className="size-3 stroke-[3]" /> : <span className="size-1.5 rounded-full bg-current" />}</span><span><span className="text-[12px] font-semibold text-[#253047]"><StageLabel stage={stage} /></span><span className={cn("ml-2 rounded-full px-2 py-0.5 text-[9px] font-semibold", stageStateMeta[stage.state].badge)}>{stageStateMeta[stage.state].label}</span><span data-preserve-language={stageLabels[stage.id] ? undefined : true} className="mt-1 block text-[10px] leading-4 text-[#7d889a]">{stage.description}</span></span></div>)}</div> : <p className="mt-4 text-xs text-[#8792a5]">暂无已核验的阶段时间线。</p>}
          </section>
          <div className="space-y-5">
            <section className={cn(cardClass, "p-6")}><h3 className="text-[15px] font-semibold text-[#101827]">备注</h3><div className="mt-4 rounded-xl bg-[#f7f9fc] px-4 py-4 text-xs text-[#7d889a]"><TextValue value={hasDataText(po.notes) ? po.notes : po.note} fallback="暂无备注。" /></div></section>
            <section className={cn(cardClass, "p-6")}><h3 className="text-[15px] font-semibold text-[#101827]">附件（{attachments.length}）</h3>{attachments.length ? <div className="mt-4 space-y-2">{attachments.slice(0, 3).map((attachment, index) => <button key={attachment.id ?? index} type="button" onClick={onOpenDocuments} className="flex w-full items-center gap-3 rounded-xl border border-[#e8ecf2] px-3 py-3 text-left transition hover:border-[#b9cbef] hover:bg-[#f8faff]"><FileText className="size-4 shrink-0 text-[#63738b]" /><span data-preserve-language={hasDataText(attachment.fileName) ? true : undefined} className="min-w-0 flex-1 truncate text-xs font-medium text-[#26364f]">{asText(attachment.fileName, "未命名附件")}</span><ChevronRight className="size-3.5 text-[#9aa5b4]" /></button>)}</div> : <p className="mt-4 text-xs text-[#8792a5]">暂无文档。</p>}</section>
          </div>
        </div>
      </div>

      <aside className="space-y-5">
        <section className={cn(cardClass, "h-[264px] p-6")}>
          <h3 className="text-[15px] font-semibold text-[#101827]">订单摘要</h3>
          <dl className="mt-4 space-y-3 text-[12px]"><div className="flex justify-between gap-3"><dt className="text-[#7d889a]">行项目合计</dt><dd className="font-semibold text-[#202a3a]">{formatMoney(amountTotal, currency)}</dd></div><div className="flex justify-between gap-3"><dt className="text-[#7d889a]">行项目</dt><dd className="font-semibold text-[#202a3a]">{itemRows.length}</dd></div><div className="flex justify-between gap-3 border-t border-[#eef1f5] pt-4"><dt className="font-semibold text-[#202a3a]">合计</dt><dd className="text-[17px] font-bold text-[#3569df]">{formatMoney(amountTotal, currency)}</dd></div></dl>
          <div className="mt-5"><div className="flex justify-between gap-3 text-[11px] font-semibold text-[#253047]"><span>订单进度</span><span>{progress === null ? "—" : `${progress}%`}</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-[#e8edf5]"><div className="h-full rounded-full bg-[#3569df]" style={{ width: progress === null ? "0%" : `${progress}%` }} /></div><div className="mt-2 text-[10px] text-[#8792a5]">{stages.length ? `已完成 ${completedStages} / ${stages.length} 个阶段` : "暂无已核验阶段"}</div></div>
        </section>
        <section className={cn(cardClass, "p-6")}>
          <h3 className="text-[15px] font-semibold text-[#101827]">风险与详情</h3>
          <dl className="mt-5 divide-y divide-[#eef1f5] text-[11px]"><div className="flex justify-between gap-3 pb-4"><dt className="text-[#7d889a]">风险等级</dt><dd className={cn("font-semibold", risk === "high" ? "text-[#d84e4e]" : risk === "medium" ? "text-[#c77b1d]" : "text-[#346edd]")}><span className="mr-1.5 inline-block size-1.5 rounded-full bg-current" />{riskLabel}</dd></div><div className="py-4"><dt className="text-[#7d889a]">分析结果</dt><dd data-preserve-language className="mt-1 font-semibold text-[#253047]">{asText(primaryRisk?.label)}</dd></div><div className="py-4"><dt className="text-[#7d889a]">下一步操作</dt><dd data-preserve-language className="mt-1 font-medium leading-5 text-[#4e5d72]">{asText(item.po.nextAction)}</dd></div><div className="pt-4"><dt className="text-[#7d889a]">当前阶段</dt><dd className="mt-1 font-semibold text-[#253047]"><StageLabel stage={currentStage ?? { id: asText(item.po.stage, ""), label: asText(item.po.stageLabel) }} /></dd></div></dl>
          {reminderAction ? <><button id="po-ai-action-followup-confirm" type="button" disabled={reminderAction.ready === false} title={reminderAction.readinessMessage} onClick={() => onAction(reminderAction)} className="mt-6 h-11 w-full scroll-mt-6 rounded-xl bg-[#3569df] text-xs font-semibold text-white shadow-sm transition hover:bg-[#285bc1] disabled:cursor-not-allowed disabled:opacity-45">{reminderAction.label}</button>{reminderAction.ready === false && reminderAction.readinessMessage ? <div className="mt-2 text-xs leading-5 text-amber-800"><span>{reminderAction.readinessMessage}</span>{reminderAction.readinessTarget ? <button type="button" onClick={() => onResolveReadiness(reminderAction.readinessTarget!)} className="mt-1 block font-semibold underline">{reminderAction.readinessTarget === "documents" ? "查看附件状态" : "前往设置与连接"}</button> : null}</div> : null}</> : null}
        </section>
        {workflowActions.length ? <section id="po-ai-actions" aria-label="下一步操作" className={cn(cardClass, "scroll-mt-6 p-5 sm:p-6")}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-[15px] font-semibold text-[#101827]">下一步操作</h3><span className="text-xs text-[#778398]">核对事实后再次确认，不会自动执行</span></div>
          <div className="mt-4 grid gap-3">{workflowActions.map((action) => <div key={action.id} className="rounded-xl border border-[#e3e8ef] p-4">
            <button id={`po-ai-action-${action.id}`} type="button" disabled={action.ready === false} onClick={() => onAction(action)} className={cn("min-h-10 scroll-mt-6 rounded-lg px-3 py-2 text-left text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45", action.tone === "danger" ? "bg-red-50 text-red-700 hover:bg-red-100" : "bg-[#edf3ff] text-[#285bc1] hover:bg-[#dfeaff]")}>{action.label}</button>
            <p data-preserve-language={action.preserveDescription ? true : undefined} className="mt-2 text-xs leading-5 text-[#718198]">{action.description}</p>
            {action.ready === false && action.readinessMessage ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900"><span>{action.readinessMessage}</span>{action.readinessTarget ? <button type="button" onClick={() => onResolveReadiness(action.readinessTarget!)} className="mt-1 block font-semibold underline underline-offset-4">{action.readinessTarget === "documents" ? "查看附件状态" : "前往设置与连接"}</button> : null}</div> : null}
          </div>)}</div>
        </section> : null}
      </aside>
    </div>
  </div>;
}

function DetailContent({
  item,
  detail,
  loading,
  error,
  tab,
  setTab,
  actions,
  onAction,
  onEdit,
  onMarkAtRisk,
  onDuplicate,
  onCancel,
  onResolveReadiness,
  onClose,
  onRetry,
  onRefresh,
  permissions,
  navigationIntent,
  onNavigationIntentConsumed,
  presentation,
  returnLabel,
  onPrevious,
  onNext,
}: {
  item: QueueItem;
  detail: ContextPayload | null;
  loading: boolean;
  error: string | null;
  tab: DetailTab;
  setTab: (tab: DetailTab) => void;
  actions: ActionPlan[];
  onAction: (plan: ActionPlan) => void;
  onEdit: (target: EditPurchaseOrderTarget, returnFocusElement?: HTMLElement | null) => void;
  onMarkAtRisk: (target: MarkAtRiskTarget, returnFocusElement?: HTMLElement | null) => void;
  onDuplicate: (target: DuplicatePurchaseOrderTarget, returnFocusElement?: HTMLElement | null) => void;
  onCancel: (target: CancelPurchaseOrderTarget, returnFocusElement?: HTMLElement | null) => void;
  onResolveReadiness: (target: NonNullable<PoSendActionReadiness["target"]>) => void;
  onClose: () => void;
  onRetry: () => void;
  onRefresh: () => Promise<void>;
  permissions: { operate?: boolean; approve?: boolean };
  navigationIntent?: PurchaseOrderNavigationIntent | null;
  onNavigationIntentConsumed?: () => void;
  presentation: "panel" | "page";
  returnLabel?: string;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const { formatDate: formatTenantDate, formatShortDateTime } = useProcurementLocale();
  const formatDate = (value: unknown) => formatTenantDate(typeof value === "string" ? value : null);
  const formatTime = (value: unknown) => formatShortDateTime(typeof value === "string" ? value : null, "时间未记录");
  const formatPageMoney = (value: unknown, currency: unknown) => {
    const amount = asNumber(value);
    if (amount === undefined) return "—";
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: asText(currency, "USD") }).format(amount); }
    catch { return `${amount.toLocaleString("en-US")} ${asText(currency, "")}`.trim(); }
  };
  const [selectedActionId, setSelectedActionId] = useState<string | null>(actions.find((action) => action.ready !== false)?.id ?? null);
  const tabButtonRefs = useRef<Partial<Record<DetailTab, HTMLButtonElement | null>>>({});
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const [tabScrollState, setTabScrollState] = useState({ canScrollLeft: false, canScrollRight: false });
  const [documentSearch, setDocumentSearch] = useState("");
  const [selectedDocumentKey, setSelectedDocumentKey] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [itemDeliveryFilter, setItemDeliveryFilter] = useState<ItemDeliveryFilter>("all");
  const [itemPage, setItemPage] = useState(1);
  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const [documentAction, setDocumentAction] = useState<"download" | "print" | null>(null);
  const documentActionInFlightRef = useRef(false);
  const [documentActionError, setDocumentActionError] = useState<string | null>(null);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const actionsFocusIntentRef = useRef<"first" | "trigger" | "download" | "print" | null>(null);
  const consumedNavigationIntentRef = useRef<string | null>(null);
  useEffect(() => { setSelectedActionId(actions.find((action) => action.ready !== false)?.id ?? null); }, [actions, item.po.id]);
  useEffect(() => { setDocumentSearch(""); setSelectedDocumentKey(null); setSelectedThreadId(null); setItemSearch(""); setItemDeliveryFilter("all"); setItemPage(1); }, [item.po.id]);
  useEffect(() => { setItemPage(1); }, [itemDeliveryFilter, itemSearch]);
  useLayoutEffect(() => {
    const intent = actionsFocusIntentRef.current;
    if (intent === "first" && actionsMenuOpen) {
      const firstEnabled = actionsMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      if (firstEnabled) {
        actionsFocusIntentRef.current = null;
        firstEnabled.focus({ preventScroll: true });
      }
      return;
    }
    if (intent === "trigger" && !actionsMenuOpen) {
      actionsFocusIntentRef.current = null;
      actionsTriggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if ((intent === "download" || intent === "print") && actionsMenuOpen && documentAction === null) {
      const initiatingItem = actionsMenuRef.current?.querySelector<HTMLButtonElement>(`[data-document-action="${intent}"]`);
      if (initiatingItem && !initiatingItem.disabled) {
        actionsFocusIntentRef.current = null;
        initiatingItem.focus({ preventScroll: true });
      }
    }
  }, [actionsMenuOpen, documentAction]);
  useEffect(() => {
    if (!actionsMenuOpen) return;
    const closeActionsMenuOnOutsidePress = (event: MouseEvent) => {
      if (actionsMenuRef.current?.contains(event.target as Node)) return;
      setActionsMenuOpen(false);
    };
    const closeActionsMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      actionsFocusIntentRef.current = "trigger";
      setActionsMenuOpen(false);
    };
    document.addEventListener("mousedown", closeActionsMenuOnOutsidePress);
    document.addEventListener("keydown", closeActionsMenuOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeActionsMenuOnOutsidePress);
      document.removeEventListener("keydown", closeActionsMenuOnEscape);
    };
  }, [actionsMenuOpen]);
  const po = detail?.purchaseOrders?.find((entry) => entry.id === item.po.id) ?? detail?.purchaseOrders?.[0] ?? item.po;
  const poDisplayNumber = asText(po.displayNumber, asText(po.number, asText(po.externalId, compactId(po.id))));
  const supplier = detail?.poDetail?.supplier ?? detail?.suppliers?.find((entry) => entry.id === po.supplierId);
  const supplierProfile = detail?.poDetail?.supplierProfile;
  const supplierAddress = supplierProfile?.address && typeof supplierProfile.address === "object" && !Array.isArray(supplierProfile.address)
    ? Object.values(supplierProfile.address as Row).filter((value): value is string => typeof value === "string" && Boolean(value.trim())).join(", ")
    : undefined;
  const poLines = detail?.linesByDocument?.[asText(po.id, "")] ?? rows(po.lines);
  const firstLine = poLines[0];
  const confirmation = detail?.confirmations?.at(-1);
  const confirmationLines = confirmation ? detail?.linesByDocument?.[asText(confirmation.id, "")] ?? rows(confirmation.lines) : [];
  const confirmationLine = confirmationLines[0];
  const itemRows = buildPoDetailItemRows({ po, lines: poLines, quantityProjections: detail?.quantityProjections ?? [], confirmationLines });
  const hasDelayedItems = itemRows.some((entry) => (entry.delayedQuantity ?? 0) > 0);
  const visibleItemRows = itemRows.filter((entry) => {
    const query = itemSearch.trim().toLocaleLowerCase();
    return (!query || `${entry.label} ${entry.sku ?? ""} ${entry.category ?? ""}`.toLocaleLowerCase().includes(query))
      && (itemDeliveryFilter === "all" || (itemDeliveryFilter === "delayed" ? (entry.delayedQuantity ?? 0) > 0 : (entry.delayedQuantity ?? 0) <= 0));
  });
  const itemTotalPages = Math.max(1, Math.ceil(visibleItemRows.length / 5));
  const currentItemPage = Math.min(itemPage, itemTotalPages);
  const itemPageOffset = (currentItemPage - 1) * 5;
  const paginatedItemRows = visibleItemRows.slice(itemPageOffset, itemPageOffset + 5);
  const itemCurrency = asText(po.currency ?? item.po.currency, "CNY");
  const itemTotalQuantity = itemRows.reduce((sum, entry) => sum + (entry.orderedQty ?? 0), 0);
  const itemLinesTotal = itemRows.reduce((sum, entry) => sum + (entry.total ?? 0), 0);
  const itemTotalValue = itemLinesTotal > 0 ? itemLinesTotal : asNumber(item.po.amountTotal ?? po.amountTotal);
  const supplierContacts = rows(supplier?.contacts);
  const supplierContactsRecorded = supplier !== undefined && Array.isArray(supplier.contacts);
  const matchedSlaRules = poDetailMatchedSlaRules(detail?.stageTimeline ?? []);
  const fulfilmentEvidence = buildPoDetailFulfilmentEvidence({ shipments: detail?.shipments ?? [], receipts: detail?.receipts ?? [] });
  const deliveryLines = itemRows
    .filter((line) => line.shippedQty !== undefined && line.receivedQty !== undefined)
    .map((line) => ({ id: line.id, label: line.label, uom: line.uom, ordered: line.orderedQty, shipped: line.shippedQty!, received: line.receivedQty! }));
  const communications = sortPoDetailCommunications(detail?.poDetail?.communication?.messages ?? (detail?.communications ?? []).filter((entry) => entry.businessObjectId === po.id));
  const communicationKpis = detail?.poDetail?.communication?.kpis;
  const relatedThreads = detail?.poDetail?.communication?.relatedThreads ?? [];
  const visibleCommunications = selectedThreadId
    ? communications.filter((entry) => entry.messageId === selectedThreadId || entry.inReplyTo === selectedThreadId)
    : communications;
  const documentRows = detail?.poDetail?.documents?.rows ?? [];
  const documentRequirements = detail?.poDetail?.documents?.requirements ?? [];
  const documentKpis = detail?.poDetail?.documents?.kpis;
  const visibleDocumentRows = documentRows.filter((entry) => {
    const query = documentSearch.trim().toLocaleLowerCase();
    return !query || `${asText(entry.name)} ${asText(entry.category)} ${asText(entry.createdBy, asText(entry.uploadedBy))}`.toLocaleLowerCase().includes(query);
  });
  const selectedDocument = documentRows.find((entry) => asText(entry.snapshotId, asText(entry.id)) === selectedDocumentKey) ?? null;
  const pendingApproval = (detail?.executionApprovals ?? []).find((entry) => entry.status === "pending");
  const openException = (detail?.exceptions ?? []).find((entry) => ["open", "assigned"].includes(String(entry.status ?? "")));
  const tabs = PO_DETAIL_TABS;
  const selectedAction = actions.find((action) => action.id === selectedActionId && action.ready !== false);
  const contextRenderState = poDetailContextRenderState({ hasDetail: detail !== null, loading, error });
  const auditEvents = useMemo(() => {
    const serverEvents = detail?.poDetail?.history?.events;
    if (!serverEvents?.length) return timelineEvents(detail).map((event) => ({ ...event, summary: "" }));
    return serverEvents.map((event, index) => ({
      id: asText(event.id, `history:${index}`), at: event.at,
      title: asText(event.label, asText(event.type, "业务事件")), preserveTitle: hasDataText(event.label) || hasDataText(event.type), preserveMeta: true,
      meta: `${asText(event.actor, "—")} · ${asText(event.typeLabel, asText(event.type, "未知事件"))}`,
      type: asText(event.type, ""), source: asText(event.source, ""), summary: asText(event.summary, ""),
      state: asText(event.state, "recorded"),
    }));
  }, [detail]);
  const risk = riskLevel(item);
  const newPromiseAt = confirmationLine?.promisedAt ?? confirmation?.promisedAt;
  const delayDays = asNumber(confirmationLine?.promisedAtVarianceDays);
  const needsDecision = item.group === "needs_action" || item.group === "exception";
  const currentStage = detail?.stageTimeline?.find((stage) => stage.state === "active" || stage.state === "blocked")
    ?? detail?.stageTimeline?.find((stage) => stage.state === "pending");
  const taskLabel = needsDecision
    ? "交期确认"
    : po.status === "draft" && currentStage?.id === "po_sent"
      ? "PO 发出"
      : currentStage?.label ?? asText(item.po.stageLabel, statusName(po.status));
  const taskStatus = needsDecision ? "待我处理" : currentStage?.state === "active" ? "进行中" : currentStage?.state === "blocked" ? "已阻断" : statusName(po.status);
  const editLines = poLines.map((line) => ({ id: asText(line.id, ""), itemCode: asText(line.itemId, ""), description: asText(line.description, ""), quantity: asNumber(line.orderedQty) ?? 0, unit: asText(line.uom, ""), unitPrice: asNumber(line.unitPrice) ?? null, taxRate: asNumber(line.taxRate) ?? null }));
  const editBaseline: EditPurchaseOrderValues = {
    supplierId: asText(po.supplierId, ""), contactId: typeof po.contactId === "string" ? po.contactId : null,
    requiredInHouseAt: asText(po.requiredInHouseAt, asText(firstLine?.requestedAt, "")).slice(0, 10),
    materialType: po.materialType === "indirect" ? "indirect" : "direct", lines: editLines,
  };
  const editTarget: EditPurchaseOrderTarget = {
    aggregateId: asText(po.id, ""), expectedVersion: asNumber(po.version) ?? 0, supplierId: asText(po.supplierId, ""),
    supplierName: asText(supplier?.name, asText(po.supplierName, "—")),
    supplierEmail: asText(supplierContacts.find((contact) => contact.primary)?.email, asText(supplierContacts[0]?.email, "—")),
    contactId: editBaseline.contactId, requiredInHouseAt: editBaseline.requiredInHouseAt,
    materialType: editBaseline.materialType, stage: stageDisplayLabel(currentStage ?? { id: asText(po.stage, ""), label: asText(po.stageLabel) }), status: statusName(po.status),
    localizeStage: !!stageLabels[currentStage?.id ?? asText(po.stage, "")], localizeStatus: !!statusNames[asText(po.status, "")],
    external: po.sourceSystem !== "readywork" || po.status !== "draft" || Boolean(po.odooReference), lines: editLines, baseline: editBaseline,
    suppliers: rows(detail?.suppliers).map((candidate) => ({ id: asText(candidate.id, ""), name: asText(candidate.name, "—"), email: asText(rows(candidate.contacts).find((contact) => contact.primary)?.email, asText(rows(candidate.contacts)[0]?.email, "—")), contacts: rows(candidate.contacts).map((contact) => ({ id: asText(contact.id, ""), name: asText(contact.name, "—") })) })),
  };
  const cancelTarget: CancelPurchaseOrderTarget = {
    aggregateId: asText(po.id, ""),
    expectedVersion: asNumber(po.version) ?? 0,
    purchaseOrderNumber: poDisplayNumber,
    sourceSystem: asText(po.sourceSystem, "readywork"),
    blockers: purchaseOrderCancellationBlockers(po, detail),
    existingRequest: detail?.purchaseOrderCancellation ?? null,
  };
  const markAtRiskReadiness = item.po.actionReadiness && typeof item.po.actionReadiness === "object" && !Array.isArray(item.po.actionReadiness)
    ? (item.po.actionReadiness as Row).mark_at_risk as Row | undefined
    : undefined;
  const markAtRiskTarget: MarkAtRiskTarget = {
    aggregateId: asText(po.id, ""),
    expectedVersion: asNumber(po.version) ?? asNumber(item.po.version) ?? 0,
    purchaseOrderNumber: poDisplayNumber,
    stage: asText(item.po.stage, asText(currentStage?.id, "po_sent")),
    currentRisk: asText(item.po.risk, "unknown"),
    requiredInHouseAt: asText(po.requiredInHouseAt, asText(firstLine?.requestedAt, "")),
    ready: markAtRiskReadiness?.ready === true,
    readinessMessage: asText(markAtRiskReadiness?.message, "当前权威工作台没有提供创建人工风险事实所需的就绪信息。"),
  };

  const consumeNavigationIntent = useEffectEvent((intent: PurchaseOrderNavigationIntent) => {
    if (intent === "edit-rihd") onEdit({ ...editTarget, rihdOnly: true }, actionsTriggerRef.current);
    else onMarkAtRisk(markAtRiskTarget, actionsTriggerRef.current);
    onNavigationIntentConsumed?.();
  });

  useEffect(() => {
    if (!navigationIntent) {
      consumedNavigationIntentRef.current = null;
      return;
    }
    if (loading || error || !detail) return;
    const key = `${asText(po.id, asText(item.po.id))}:${navigationIntent}`;
    if (consumedNavigationIntentRef.current === key) return;
    consumedNavigationIntentRef.current = key;
    consumeNavigationIntent(navigationIntent);
  }, [detail, error, item.po.id, loading, navigationIntent, po.id]);

  const createDocumentSnapshot = async (purpose: "download" | "print") => {
    if (documentActionInFlightRef.current || documentAction || !permissions.operate) return;
    documentActionInFlightRef.current = true;
    setDocumentActionError(null);
    setDocumentAction(purpose);
    try {
      await openPoDocumentSnapshot({ purchaseOrderId: asText(po.id, ""), expectedVersion: asNumber(po.version) ?? 0, purpose });
      actionsFocusIntentRef.current = "trigger";
      setActionsMenuOpen(false);
      await onRefresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成采购订单文档失败，请稍后重试。";
      actionsFocusIntentRef.current = purpose;
      setDocumentActionError(message);
      uiAlert(message);
    } finally {
      documentActionInFlightRef.current = false;
      setDocumentAction(null);
    }
  };

  const updateTabScrollState = useCallback(() => {
    const tabList = tabListRef.current;
    if (!tabList) return;
    const remaining = tabList.scrollWidth - tabList.clientWidth - tabList.scrollLeft;
    setTabScrollState({
      canScrollLeft: tabList.scrollLeft > 1,
      canScrollRight: remaining > 1,
    });
  }, []);

  const revealDetailTab = useCallback((targetTab: DetailTab, behavior: ScrollBehavior = "smooth") => {
    const tabList = tabListRef.current;
    const tabButton = tabButtonRefs.current[targetTab];
    if (!tabList || !tabButton) return;
    const listRect = tabList.getBoundingClientRect();
    const buttonRect = tabButton.getBoundingClientRect();
    const revealPadding = 8;
    if (buttonRect.left < listRect.left + revealPadding) {
      tabList.scrollTo({ left: tabList.scrollLeft - (listRect.left + revealPadding - buttonRect.left), behavior });
    } else if (buttonRect.right > listRect.right - revealPadding) {
      tabList.scrollTo({ left: tabList.scrollLeft + (buttonRect.right - listRect.right + revealPadding), behavior });
    }
  }, []);

  useEffect(() => {
    const tabList = tabListRef.current;
    if (!tabList) return;
    const frame = window.requestAnimationFrame(updateTabScrollState);
    const resizeObserver = new ResizeObserver(updateTabScrollState);
    resizeObserver.observe(tabList);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [updateTabScrollState]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      revealDetailTab(tab, "auto");
      updateTabScrollState();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [item.po.id, revealDetailTab, tab, updateTabScrollState]);

  const scrollDetailTabs = (direction: -1 | 1) => {
    const tabList = tabListRef.current;
    if (!tabList) return;
    tabList.scrollBy({ left: direction * tabList.clientWidth, behavior: "smooth" });
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, currentTab: DetailTab) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextTab = poDetailTabForKeyboardNavigation(currentTab, event.key as PoDetailTabKeyboardKey);
    setTab(nextTab);
    tabButtonRefs.current[nextTab]?.focus();
  };

  const openChatSuggestedAction = (actionId: string) => {
    const target = actions.find((action) => action.id === actionId);
    setTab("overview");
    if (target) setSelectedActionId(target.id);
    window.requestAnimationFrame(() => {
      const control = document.getElementById(target ? `po-ai-action-${target.id}` : "po-ai-actions");
      control?.scrollIntoView({ behavior: "smooth", block: "center" });
      const focusTarget = control instanceof HTMLButtonElement ? control : control?.querySelector<HTMLButtonElement>("button:not(:disabled)");
      focusTarget?.focus({ preventScroll: true });
    });
  };

  const analysis = openException ? asText(openException.aiJudgment, "当前订单有未处理异常。")
    : pendingApproval ? asText(pendingApproval.reason, "供应商确认存在差异，需要人工审批。")
      : currentStage?.id === "supplier_commitment" ? "供应商回复尚未形成覆盖全部 PO 行的合法确认；数量或交期差异批准前，订单继续停留在 Supplier Commitment。"
        : currentStage?.id === "fulfilment_production" ? "供应商承诺已完成，员工正在跟踪备货、生产与交付风险。"
          : currentStage?.id === "dispatch_transit" ? "订单已进入发运 / 在途阶段，员工正在跟踪行级发运数量、ETA 与运输节点。"
            : currentStage?.id === "delivery_grn" ? "订单已进入交付 / GRN 阶段，员工正在核验行级收货与 ERP 回执。"
          : po.status === "draft" && po.sourceSystem === "readywork" && !po.odooReference
            ? "PO Draft 已就绪；当前尚未获得 Odoo 草稿回执，需先完成 ERP 映射再进入真实发送。"
            : po.status === "draft" ? "PO Draft 已就绪，发送前将再次检查版本、权限和邮箱连接。"
            : "当前没有需要人工介入的已知异常。";

  const pagePresentation = presentation === "page";
  const displayReturnLabel = ({ Overview: "总览", "Purchase Orders": "采购订单", "Local Procurement": "本地采购", "Import Procurement": "进口采购", Notifications: "通知", "Risk Dashboard": "风险看板" } as Record<string, string>)[returnLabel ?? "Overview"] ?? returnLabel ?? "总览";

  return <div data-po-detail-presentation={presentation} className={cn("flex min-h-0 flex-col", pagePresentation ? "min-h-[calc(100vh-9rem)] bg-transparent" : "h-full bg-white")}>
    {pagePresentation ? <header data-po-page-header className="border-b border-[#e4e8ef]">
      <div className="flex min-h-[52px] items-center gap-3">
        <button type="button" aria-label={`返回${displayReturnLabel}`} onClick={onClose} className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[#e1e6ed] bg-white text-[#647188] shadow-sm transition hover:bg-[#f7f9fc] hover:text-[#172033]"><ArrowLeft className="size-4" /><span className="sr-only">{`返回${displayReturnLabel}`}</span></button>
        <nav aria-label="面包屑导航" className="flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-[#7e899a]"><span>总览</span><ChevronRight className="size-3 text-[#b0bac8]" /><span>{displayReturnLabel}</span><ChevronRight className="size-3 text-[#b0bac8]" /><span aria-current="page" className="font-semibold text-[#334056]">{poDisplayNumber}</span></nav>
      </div>
      <div className="flex min-h-[72px] flex-col justify-between gap-4 pb-[14px] pt-1 lg:flex-row lg:items-start">
        <div className="min-w-0"><div className="flex flex-wrap items-center gap-2.5"><h1 id="po-context-title" className="text-[24px] font-bold tracking-[-0.025em] text-[#101827]">采购订单 #{poDisplayNumber}</h1><span className="rounded-full bg-[#e9efff] px-3 py-1 text-[10px] font-semibold text-[#4b66c8]"><StageLabel stage={currentStage ?? { id: asText(item.po.stage, ""), label: asText(item.po.stageLabel) }} /></span>{(asNumber(item.po.overdueDays) ?? 0) > 0 ? <span className="rounded-full bg-[#fde8e8] px-3 py-1 text-[10px] font-semibold text-[#c34a4a]"><AlertTriangle className="mr-1 inline size-3" />已逾期 {asNumber(item.po.overdueDays)} 天</span> : null}</div><p className="mt-1.5 text-[11px] text-[#7d889a]">创建于 {formatDate(po.createdAt ?? po.orderedAt)} <span className="px-1">•</span> <span data-preserve-language>{asText(supplier?.name, asText(po.supplierName, asText(po.supplierId)))}</span> <span className="px-1">•</span> {item.po.route === "local" ? "本地采购" : item.po.route === "import" ? "进口采购" : "未分类采购"}</p></div>
        <div className="flex shrink-0 items-center gap-2"><div ref={actionsMenuRef} className="relative"><button ref={actionsTriggerRef} data-po-actions-trigger type="button" aria-haspopup="menu" aria-expanded={actionsMenuOpen} onClick={() => { actionsFocusIntentRef.current = actionsMenuOpen ? null : "first"; setActionsMenuOpen(!actionsMenuOpen); }} className="flex h-9 items-center gap-1.5 rounded-xl border border-[#dfe5ed] bg-white px-4 text-xs font-medium text-[#26364f] shadow-sm transition hover:bg-slate-50">操作<ChevronDown className={cn("size-3.5 transition", actionsMenuOpen && "rotate-180")} /></button>{actionsMenuOpen ? <div role="menu" onKeyDown={(event) => { const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]; const index = items.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : -1; if (next >= 0) { event.preventDefault(); items[next]?.focus(); } }} className="absolute right-0 top-11 z-20 w-[180px] overflow-hidden rounded-xl border border-[#dfe6ef] bg-white p-1.5 shadow-[0_14px_35px_rgba(15,27,51,0.16)]">
          <button type="button" role="menuitem" disabled={permissions.operate !== true} onClick={() => { setActionsMenuOpen(false); onEdit(editTarget, actionsTriggerRef.current); }} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-xs font-semibold text-[#34445d] hover:bg-[#f5f8fc] disabled:cursor-not-allowed disabled:opacity-40">编辑采购订单</button>
          <button type="button" role="menuitem" disabled={permissions.operate !== true || detail?.actionReadiness?.duplicate_po?.ready !== true} title={detail?.actionReadiness?.duplicate_po?.message} onClick={() => { setActionsMenuOpen(false); onDuplicate({ aggregateId: asText(po.id), expectedVersion: asNumber(po.version) ?? 0, purchaseOrderNumber: poDisplayNumber, requiredInHouseAt: asText(po.requiredInHouseAt, asText(firstLine?.requestedAt, "")), supplierName: asText(supplier?.name, asText(po.supplierName, asText(po.supplierId, ""))), lineCount: poLines.length }, actionsTriggerRef.current); }} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-xs font-semibold text-[#34445d] hover:bg-[#f5f8fc] disabled:cursor-not-allowed disabled:opacity-40">复制订单</button>
          <button type="button" role="menuitem" data-document-action="download" disabled={permissions.operate !== true || documentAction !== null} onClick={() => void createDocumentSnapshot("download")} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-xs font-semibold text-[#34445d] hover:bg-[#f5f8fc] disabled:cursor-not-allowed disabled:opacity-40">{documentAction === "download" ? "正在生成 PDF…" : <>下载 PDF</>}</button>
          <button type="button" role="menuitem" data-document-action="print" disabled={permissions.operate !== true || documentAction !== null} onClick={() => void createDocumentSnapshot("print")} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-xs font-semibold text-[#34445d] hover:bg-[#f5f8fc] disabled:cursor-not-allowed disabled:opacity-40">{documentAction === "print" ? "正在生成打印视图…" : <>打印</>}</button>
          <div role="separator" className="my-1 border-t border-[#edf1f6]" />
          <button type="button" role="menuitem" disabled={permissions.operate !== true || permissions.approve !== true} title={permissions.operate === true && permissions.approve === true ? "核对取消后果与阻断条件" : "取消订单需要操作和审批权限"} onClick={() => { setActionsMenuOpen(false); onCancel(cancelTarget, actionsTriggerRef.current); }} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40">取消采购订单</button>
          {documentActionError ? <div role="alert" className="mx-1 mt-1 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[10px] leading-4 text-red-700">{documentActionError}</div> : null}
          {detail?.actionReadiness?.duplicate_po?.ready === false ? <div className="border-t border-[#edf1f6] px-3 py-2 text-[10px] leading-4 text-amber-700">{detail.actionReadiness.duplicate_po.message}</div> : null}
        </div> : null}</div><button type="button" aria-label="上一张订单" disabled={!onPrevious} onClick={onPrevious} className="flex size-9 items-center justify-center rounded-xl border border-[#dfe5ed] bg-white text-[#627086] shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"><ChevronLeft className="size-4" /><span className="sr-only">上一张订单</span></button><button type="button" aria-label="下一张订单" disabled={!onNext} onClick={onNext} className="flex size-9 items-center justify-center rounded-xl border border-[#dfe5ed] bg-white text-[#627086] shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"><ChevronRight className="size-4" /><span className="sr-only">下一张订单</span></button></div>
      </div>
    </header> : null}
    {!pagePresentation ? <div className="border-b border-[#e4eaf2]">
      <div className={cn("flex items-center justify-between border-b border-[#e4eaf2] px-6", pagePresentation ? "min-h-[82px] py-4" : "h-[64px]")}>{pagePresentation ? <h1 id="po-context-title" className="text-[26px] font-semibold tracking-[-0.025em] text-[#13203a]">采购订单 #{poDisplayNumber}</h1> : <div id="po-context-title" className="text-[17px] font-semibold tracking-tight text-[#13203a]">任务详情</div>}<div className="flex items-center gap-1.5"><div ref={actionsMenuRef} className="relative"><button ref={actionsTriggerRef} data-po-actions-trigger type="button" aria-haspopup="menu" aria-expanded={actionsMenuOpen} onClick={() => { actionsFocusIntentRef.current = actionsMenuOpen ? null : "first"; setActionsMenuOpen(!actionsMenuOpen); }} className="flex h-9 items-center gap-1.5 rounded-lg border border-[#d9e1ec] bg-white px-3 text-xs font-semibold text-[#26364f] transition hover:bg-slate-50">操作<ChevronDown className={cn("size-3.5 transition", actionsMenuOpen && "rotate-180")} /></button>{actionsMenuOpen ? <div role="menu" onKeyDown={(event) => { const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')]; const index = items.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : -1; if (next >= 0) { event.preventDefault(); items[next]?.focus(); } }} className="absolute right-0 top-11 z-20 w-[180px] overflow-hidden rounded-xl border border-[#dfe6ef] bg-white p-1.5 shadow-[0_14px_35px_rgba(15,27,51,0.16)]">
        <button type="button" role="menuitem" disabled={permissions.operate !== true} onClick={() => { setActionsMenuOpen(false); onEdit(editTarget, actionsTriggerRef.current); }} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-xs font-semibold text-[#34445d] hover:bg-[#f5f8fc] disabled:cursor-not-allowed disabled:opacity-40">编辑采购订单</button>
        <button type="button" role="menuitem" disabled={permissions.operate !== true || detail?.actionReadiness?.duplicate_po?.ready !== true} title={detail?.actionReadiness?.duplicate_po?.message} onClick={() => { setActionsMenuOpen(false); onDuplicate({ aggregateId: asText(po.id), expectedVersion: asNumber(po.version) ?? 0, purchaseOrderNumber: poDisplayNumber, requiredInHouseAt: asText(po.requiredInHouseAt, asText(firstLine?.requestedAt, "")), supplierName: asText(supplier?.name, asText(po.supplierName, asText(po.supplierId, ""))), lineCount: poLines.length }, actionsTriggerRef.current); }} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-xs font-semibold text-[#34445d] hover:bg-[#f5f8fc] disabled:cursor-not-allowed disabled:opacity-40">复制订单</button>
        <button type="button" role="menuitem" data-document-action="download" disabled={permissions.operate !== true || documentAction !== null} onClick={() => void createDocumentSnapshot("download")} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-xs font-semibold text-[#34445d] hover:bg-[#f5f8fc] disabled:cursor-not-allowed disabled:opacity-40">{documentAction === "download" ? "正在生成 PDF…" : <>下载 PDF</>}</button>
        <button type="button" role="menuitem" data-document-action="print" disabled={permissions.operate !== true || documentAction !== null} onClick={() => void createDocumentSnapshot("print")} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-xs font-semibold text-[#34445d] hover:bg-[#f5f8fc] disabled:cursor-not-allowed disabled:opacity-40">{documentAction === "print" ? "正在生成打印视图…" : <>打印</>}</button>
        <div role="separator" className="my-1 border-t border-[#edf1f6]" />
        <button type="button" role="menuitem" disabled={permissions.operate !== true || permissions.approve !== true} title={permissions.operate === true && permissions.approve === true ? "核对取消后果与阻断条件" : "取消订单需要操作和审批权限"} onClick={() => { setActionsMenuOpen(false); onCancel(cancelTarget, actionsTriggerRef.current); }} className="flex h-9 w-full items-center rounded-lg px-3 text-left text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40">取消采购订单</button>
        {documentActionError ? <div role="alert" className="mx-1 mt-1 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[10px] leading-4 text-red-700">{documentActionError}</div> : null}
        {detail?.actionReadiness?.duplicate_po?.ready === false ? <div className="border-t border-[#edf1f6] px-3 py-2 text-[10px] leading-4 text-amber-700">{detail.actionReadiness.duplicate_po.message}</div> : null}
      </div> : null}</div>{pagePresentation ? null : <button data-detail-initial-focus type="button" aria-label="关闭任务详情" onClick={onClose} className="flex size-9 items-center justify-center rounded-lg text-[#62738d] hover:bg-slate-100"><X className="size-5" /></button>}</div></div>
      <div className="px-6 pb-6 pt-6">
        <div className="flex items-start justify-between gap-3"><div className="min-w-0 break-all text-[13px] font-semibold tracking-[0.04em] text-[#718198]">{poDisplayNumber}</div><span className={cn("shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold", needsDecision ? "border-red-300 bg-red-50 text-red-500" : risk === "medium" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 bg-slate-50 text-slate-500")}>{taskStatus}</span></div>
        <h2 data-po-task-heading className="mt-2 break-words text-[21px] font-semibold leading-[1.25] tracking-[-0.025em] text-[#13203a]">{taskLabel}</h2>
        <div className="mt-6 grid grid-cols-[minmax(112px,1fr)_minmax(0,1.55fr)] gap-x-3 gap-y-[18px] text-[13px] leading-5">
          <span className="font-medium text-[#718198]">供应商</span><span data-preserve-language={hasDataText(supplier?.name) || hasDataText(po.supplierName) || hasDataText(po.supplierId) ? true : undefined} className="truncate font-semibold text-[#26364f]">{asText(supplier?.name, asText(po.supplierName, asText(po.supplierId, "供应商未找到")))}</span>
          <span className="font-medium text-[#718198]">物料</span><span className="truncate font-semibold text-[#26364f]">{asText(firstLine?.description, asText(firstLine?.itemId, "未记录"))}</span>
          <span className="font-medium text-[#718198]">数量</span><span className="font-semibold text-[#26364f]">{asNumber(firstLine?.orderedQty) ?? "—"} {asText(firstLine?.uom, "")}</span>
          <span className="font-medium text-[#718198]">原交期</span><span className="font-semibold text-[#26364f]">{formatDate(firstLine?.promisedAt ?? po.promisedAt ?? po.orderedAt)}</span>
          {newPromiseAt ? <><span className="font-medium text-[#718198]">新交期（供应商回复）</span><span className="font-semibold text-[#26364f]">{formatDate(newPromiseAt)}</span></> : null}
          {delayDays !== undefined ? <><span className="font-medium text-[#718198]">延期天数</span><span className={cn("font-semibold", delayDays > 0 ? "text-red-500" : "text-[#26364f]")}>{delayDays} 天</span></> : null}
          <span className="font-medium text-[#718198]">风险等级</span><span className={cn("font-semibold", risk === "high" ? "text-red-500" : risk === "medium" ? "text-amber-600" : "text-[#26364f]")}>{risk === "high" ? "高" : risk === "medium" ? "中" : risk === "low" ? "低" : "—"}</span>
          <span className="font-medium text-[#718198]">Odoo 采购单</span><span className="font-semibold text-[#26364f]">{po.sourceSystem === "odoo" ? asText(po.number, asText(po.externalId, "已映射")) : po.odooReference && typeof po.odooReference === "object" && !Array.isArray(po.odooReference) ? asText((po.odooReference as Row).name, "已映射") : "尚未创建"}</span>
        </div>
      </div>
    </div> : null}
    <div className={cn("flex items-stretch border-b border-[#e4eaf2] bg-white", pagePresentation ? "h-9 bg-transparent" : "h-[52px]")}>
      {!pagePresentation ? <button type="button" aria-label="向左滚动采购订单详情页签" disabled={!tabScrollState.canScrollLeft} onClick={() => scrollDetailTabs(-1)} className="flex w-8 shrink-0 items-center justify-center border-r border-[#edf1f6] text-[#62738d] transition hover:bg-slate-50 hover:text-[#13203a] disabled:pointer-events-none disabled:text-slate-200"><ChevronLeft className="size-4" /></button> : null}
      <div ref={tabListRef} role="tablist" aria-label="采购订单详情" aria-orientation="horizontal" onScroll={updateTabScrollState} className={cn("flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", pagePresentation ? "gap-1 px-0" : "gap-6 px-3")}>{tabs.map(({ id, label }) => <button ref={(node) => { tabButtonRefs.current[id] = node; }} key={id} id={`po-detail-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls={`po-detail-panel-${id}`} tabIndex={tab === id ? 0 : -1} type="button" onClick={() => setTab(id)} onKeyDown={(event) => handleTabKeyDown(event, id)} className={cn("relative shrink-0 text-[13px] font-medium", pagePresentation && "px-3", tab === id ? "text-[#2563eb] after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-[#2563eb]" : "text-[#64748b] hover:text-[#13203a]")}>{label}</button>)}</div>
      {!pagePresentation ? <button type="button" aria-label="向右滚动采购订单详情页签" disabled={!tabScrollState.canScrollRight} onClick={() => scrollDetailTabs(1)} className="flex w-8 shrink-0 items-center justify-center border-l border-[#edf1f6] text-[#62738d] transition hover:bg-slate-50 hover:text-[#13203a] disabled:pointer-events-none disabled:text-slate-200"><ChevronRight className="size-4" /></button> : null}
    </div>
    <div id={`po-detail-panel-${tab}`} role="tabpanel" aria-labelledby={`po-detail-tab-${tab}`} className={cn("min-h-0 flex-1", pagePresentation ? "py-6" : "overflow-y-auto px-6 py-7")}>
      {contextRenderState === "ready" && error ? <div role="alert" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">后台刷新失败，以下为最近一次成功读取的持久化数据：{error}</div> : null}
      {contextRenderState !== "ready" ? <div className="flex min-h-[320px] items-center justify-center py-20 text-center">
        {contextRenderState === "loading" ? <div className="text-sm text-slate-400"><Loader2 className="mx-auto mb-3 size-5 animate-spin" />读取订单完整上下文…</div> : contextRenderState === "error" ? <div role="alert" className="max-w-sm rounded-xl border border-red-200 bg-red-50 px-5 py-5 text-sm text-red-700"><div className="font-semibold">订单上下文读取失败</div><p className="mt-2 text-xs leading-5">{error}</p><button type="button" onClick={onRetry} className="mt-4 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100">重新读取</button></div> : <div className="max-w-sm rounded-xl border border-dashed border-slate-200 px-5 py-8 text-sm text-slate-500"><div className="font-semibold text-slate-700">订单上下文尚未加载</div><p className="mt-2 text-xs leading-5 text-slate-400">在完整业务事实返回前，不展示联系人、文档、历史或沟通空状态。</p><button type="button" onClick={onRetry} className="mt-4 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">读取上下文</button></div>}
      </div> : <>

      {tab === "overview" && (pagePresentation ? <PurchaseOrderPageOverview item={item} po={po} detail={detail} supplier={supplier} supplierProfile={supplierProfile} poDisplayNumber={poDisplayNumber} itemRows={itemRows} risk={risk} currentStage={currentStage} actions={actions} canApprove={permissions.approve === true} formatDate={formatDate} formatMoney={formatPageMoney} onAction={onAction} onOpenDocuments={() => setTab("documents")} onResolveReadiness={onResolveReadiness} /> : <div className="space-y-8">
        <div><div className="text-[15px] font-semibold text-[#13203a]">AI 判断</div><p className="mt-4 text-[13px] leading-7 text-[#52627a]">{analysis}</p>{openException?.recommendedAction ? <p className="mt-3 text-xs leading-5 text-[#397560]">建议：{asText(openException.recommendedAction)}</p> : null}</div>
        {pendingApproval && <div className="rounded-xl border border-violet-200 bg-violet-50 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-violet-800"><ShieldCheck className="size-4" />已触发审批</div><p className="mt-2 text-xs leading-5 text-violet-700">{asText(pendingApproval.reason, "数量、价格或交期差异超出自动权限。")}</p></div>}
        <div id="po-ai-actions" className="scroll-mt-6"><div className="mb-5 flex items-center justify-between"><div className="text-[15px] font-semibold text-[#13203a]">AI 建议</div><span className="text-[11px] text-slate-400">批准前会再次确认</span></div>{actions.length ? <div className="space-y-6">{actions.map((action) => <div id={`po-ai-action-${action.id}`} key={action.id} className="scroll-mt-6 space-y-2">{action.shortfallLines?.length ? <div role="alert" className="ml-10 rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-xs leading-5 text-red-800"><div className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" />这不是部分发货：剩余量将永久关闭</div><div className="mt-1">批准后系统将不再等待或补发以下数量；如仍需后续交付，请继续沟通或要求分批交付。</div><ul className="mt-2 space-y-1 border-t border-red-100 pt-2">{action.shortfallLines.map((line) => <li key={line.poLineId}><span className="font-semibold"><span data-preserve-language={"labelIsFallback" in line && line.labelIsFallback ? undefined : true}>{line.label}</span></span>：订购 {line.orderedQty} <span data-preserve-language>{line.uom}</span>，供应商确认 {line.confirmedQty} <span data-preserve-language>{line.uom}</span>，将关闭 {line.remainderQty} <span data-preserve-language>{line.uom}</span></li>)}</ul></div> : null}<button type="button" disabled={action.ready === false} onClick={() => setSelectedActionId(action.id)} className="group flex w-full items-start gap-4 text-left disabled:cursor-not-allowed"><span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2", selectedActionId === action.id ? "border-[#4f8cff]" : "border-[#d9e2ee]", action.ready === false && "border-slate-200 bg-slate-50")}><span className={cn("size-3 rounded-full", selectedActionId === action.id && "bg-[#2878ff]")} /></span><span className="min-w-0 flex-1"><span className={cn("block text-[15px] font-semibold leading-6 text-[#13203a]", action.ready === false && "text-slate-400")}>{action.label}</span><span className={cn("mt-1.5 block text-[13px] leading-6 text-[#718198]", action.ready === false && "text-slate-400")}>{action.description}</span></span></button>{action.ready === false && action.readinessMessage ? <div className="ml-10 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-800"><div>{action.readinessMessage}</div>{action.readinessTarget ? <button type="button" onClick={() => onResolveReadiness(action.readinessTarget!)} className="mt-2 font-semibold text-amber-900 underline decoration-amber-400 underline-offset-4">{action.readinessTarget === "documents" ? "查看附件状态" : "前往设置与连接"}</button> : null}</div> : null}</div>)}</div> : <div className="rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400">当前身份无可执行动作，或该状态尚未接入写操作</div>}</div>
        <StageTimeline stages={detail?.stageTimeline ?? []} showEvidence={false} />
        {deliveryLines.length > 0 && <div><div className="mb-3 flex items-center justify-between"><div className="text-[15px] font-semibold text-[#13203a]">行级交付累计</div><span className="text-[10px] text-[#94a3b8]">持久化发运 / GRN 数量投影</span></div><div className="space-y-3">{deliveryLines.map((line) => { const shippedPercent = line.ordered ? Math.min(100, line.shipped / line.ordered * 100) : 0; const receivedPercent = line.ordered ? Math.min(100, line.received / line.ordered * 100) : 0; return <div key={line.id} className="rounded-xl bg-[#f7f9fc] px-3 py-3"><div className="truncate text-[11px] font-medium text-[#46566f]"><span data-preserve-language={"labelIsFallback" in line && line.labelIsFallback ? undefined : true}>{line.label}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-[#e6ebf2]"><div className="relative h-full bg-[#8cb5ff]" style={{ width: `${shippedPercent}%` }}><div className="absolute inset-y-0 left-0 bg-[#2176ff]" style={{ width: `${shippedPercent ? receivedPercent / shippedPercent * 100 : 0}%` }} /></div></div><div className="mt-2 flex justify-between text-[10px] text-[#718198]"><span>已发 {line.shipped} / 已收 {line.received}</span><span>订购 {line.ordered} <span data-preserve-language>{line.uom}</span></span></div></div>; })}</div></div>}
        <div><div className="mb-3 text-[15px] font-semibold text-[#13203a]">制造上下文</div><ManufacturingContextPanel purchaseOrderId={asText(po.id)} permissions={permissions} /></div>
      </div>)}

      {tab === "items" && <div className="space-y-5">
        <PoTabMetrics title="采购订单指标" values={[
          { label: "订单金额", value: (asNumber(item.po.amountTotal ?? po.amountTotal) ?? 0) > 0 ? formatPageMoney(item.po.amountTotal ?? po.amountTotal, po.currency ?? item.po.currency) : "—", caption: "订单总金额" },
          { label: "行项目总数", value: itemRows.length || "—", caption: itemRows.length ? `共 ${poItemSummaryBuckets(itemRows, (entry) => entry.category).length} 个分类` : "暂无行项目" },
          { label: "要求到厂日期", value: formatDate(po.requiredInHouseAt ?? item.po.requiredInHouseAt ?? firstLine?.requestedAt), caption: (asNumber(item.po.overdueDays) ?? 0) > 0 ? `已逾期 ${asNumber(item.po.overdueDays)} 天` : "按计划进行" },
          { label: "风险等级", localizeValue: true, value: risk === "high" ? "高" : risk === "medium" ? "中" : risk === "low" ? "低" : "—" },
        ]} />
        <section className={cn(poTabCardClass, "overflow-hidden")}>
          <div className="flex flex-col gap-3 p-5 lg:flex-row lg:items-center lg:justify-between">
            <div><h3 className="text-[15px] font-semibold text-[#13203a]">{`行项目（${itemRows.length}）`}</h3><p className="mt-0.5 text-[13px] text-slate-400">此采购订单包含的全部行项目</p></div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-0"><span className="sr-only">搜索行项目</span><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><input disabled={!itemRows.length} value={itemSearch} onChange={(event) => setItemSearch(event.target.value)} placeholder="搜索物料、SKU、分类…" className="h-9 w-[230px] max-w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-[13px] outline-none transition focus:border-blue-400 focus:ring-4 focus:ring-blue-50 disabled:bg-slate-50" /></label>
              {hasDelayedItems ? <div role="group" aria-label="行项目延期筛选" className="inline-flex h-9 items-center gap-0.5 rounded-xl border border-slate-200 bg-white p-0.5 shadow-sm">{([
                ["all", "全部"], ["delayed", "延期"], ["ontrack", "按计划"],
              ] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={itemDeliveryFilter === value} onClick={() => setItemDeliveryFilter(value)} className={cn("flex h-7 items-center gap-1 rounded-lg px-2.5 text-[12.5px] font-medium transition-colors", itemDeliveryFilter === value ? "bg-slate-100 text-slate-800" : "text-slate-500 hover:text-slate-800")}>{value === "delayed" ? <AlertTriangle className="size-3.5" /> : null}{label}</button>)}</div> : <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600 shadow-sm transition hover:bg-slate-50"><SlidersHorizontal className="size-4" />筛选</button>}
              <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600 shadow-sm transition hover:bg-slate-50">按分类分组<ChevronDown className="size-3.5 opacity-60" /></button>
              <button type="button" aria-label="更多行项目操作" className="inline-flex size-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50"><MoreHorizontal className="size-4" /></button>
            </div>
          </div>
          {itemRows.length ? <>
            <div className="max-w-full overflow-x-auto"><table className="w-full min-w-[1040px] border-collapse text-left"><thead><tr className="border-y border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{["物料", "SKU", "分类", "单位", "数量", `单价 (${itemCurrency})`, "税率 (%)", `总额 (${itemCurrency})`, "要求日期", "状态"].map((label) => <th key={label} className="whitespace-nowrap px-4 py-3">{label}</th>)}<th aria-label="操作" className="px-3 py-3" /></tr></thead><tbody>{paginatedItemRows.map((line, index) => <tr key={line.id} className={cn("border-b border-slate-100 text-[13px] text-slate-600 transition hover:bg-blue-50/40", (line.delayedQuantity ?? 0) > 0 ? "bg-red-50/40" : index % 2 === 1 && "bg-slate-50/40")}><td className="px-4 py-3"><div className="flex items-center gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-400"><PackageCheck className="size-4" /></span><div><p data-preserve-language={line.labelIsFallback ? undefined : true} className="font-semibold text-slate-800"><span data-preserve-language={"labelIsFallback" in line && line.labelIsFallback ? undefined : true}>{line.label}</span></p><p data-preserve-language className="text-[11.5px] text-slate-400">{line.sku ?? "—"}</p></div></div></td><td data-preserve-language className="whitespace-nowrap px-4 py-3">{line.sku ?? "—"}</td><td data-preserve-language={line.category ? true : undefined} className="px-4 py-3">{line.category ?? "未分类"}</td><td data-preserve-language className="px-4 py-3">{line.uom ?? "—"}</td><td className="px-4 py-3 tabular-nums">{line.orderedQty ?? "—"}</td><td className="px-4 py-3 tabular-nums">{itemMoney(line.unitPrice, itemCurrency)}</td><td className="px-4 py-3 tabular-nums">{itemTaxPercent(line.tax)}</td><td className="px-4 py-3 font-semibold tabular-nums text-slate-800">{itemMoney(line.total, itemCurrency)}</td><td className="whitespace-nowrap px-4 py-3 tabular-nums">{formatDate(line.confirmedPromisedAt ?? line.requestedAt)}</td><td className="px-4 py-3"><div className="flex flex-wrap items-center gap-1.5">{line.status ? <span data-preserve-language={statusNames[line.status] ? undefined : true}><Badge tone={badgeTone(line.status)}><StatusValue value={line.status} /></Badge></span> : (line.delayedQuantity ?? 0) <= 0 ? "—" : null}{(line.delayedQuantity ?? 0) > 0 ? <Badge tone="red"><AlertTriangle className="mr-1 size-3" />延期 {line.delayedQuantity}</Badge> : null}</div></td><td className="px-3 py-3"><button type="button" aria-label={`行项目 ${line.label} 操作`} className="flex size-7 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100"><MoreHorizontal className="size-4" /></button></td></tr>)}</tbody></table></div>
            <div className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center lg:justify-between"><p className="text-[13px] text-slate-400">显示 {visibleItemRows.length === 0 ? 0 : itemPageOffset + 1} 至 {Math.min(itemPageOffset + 5, visibleItemRows.length)}，共 {visibleItemRows.length} 项</p><div className="flex flex-wrap items-center gap-6 text-[13px]"><span className="text-slate-400">总数量：<span className="font-semibold text-slate-800">{itemTotalQuantity.toLocaleString("zh-CN")}</span></span><span className="text-slate-400">{`总金额（${itemCurrency}）：`}<span className="font-semibold text-slate-800">{itemMoney(itemTotalValue, itemCurrency)}</span></span><PoItemPagination page={currentItemPage} totalPages={itemTotalPages} onChange={setItemPage} /></div></div>
          </> : <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 px-5 py-16 text-center"><span className="flex size-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400"><PackageCheck className="size-5" /></span><p className="text-[14px] font-semibold text-slate-800">暂无行项目</p><p className="text-[13px] text-slate-400">此采购订单尚未提取到行项目。</p></div>}
        </section>
        {itemRows.length ? <PoItemSummaryPanels items={itemRows} /> : null}
      </div>}

      {tab === "supplier" && <div className="space-y-4">{!supplier ? <section className={cn(poTabCardClass, "p-6")}><h3 className="text-[15px] font-semibold text-[#101827]">供应商信息</h3><p className="mt-3 text-xs text-slate-400">暂无供应商详细信息。</p></section> : <><h3 className="text-[15px] font-semibold text-[#101827]">供应商信息</h3><div className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div><div data-preserve-language={hasDataText(supplier?.name) || hasDataText(po.supplierName) || hasDataText(po.supplierId) ? true : undefined} className="text-[15px] font-semibold text-slate-800">{asText(supplier?.name, asText(po.supplierName, "供应商未找到"))}</div><div className="mt-1 font-mono text-[10px] text-slate-400">{asText(supplier?.externalId, asText(supplier?.id, asText(po.supplierId, "未记录供应商 ID")))}</div></div>{supplier?.status ? <Badge tone={badgeTone(supplier.status)}><StatusValue value={supplier.status} /></Badge> : <Badge tone="neutral">状态未记录</Badge>}</div><div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4"><Fact label="来源系统" value={supplier?.sourceSystem} /><Fact label="交易币种" value={supplier?.currency} /><Fact label="绩效分" value={supplier?.performanceScore} /><Fact label="联系人数" value={supplierContactsRecorded ? supplierContacts.length : "—"} /></div></div>
        <div className="rounded-xl border border-slate-200 p-4"><div className="flex items-center justify-between gap-3"><div className="text-xs font-semibold text-slate-800">经营档案</div>{supplierProfile?.status ? <Badge tone={badgeTone(supplierProfile.status)}><StatusValue value={supplierProfile.status} /></Badge> : null}</div><div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3"><Fact label="国家 / 地区" value={supplierProfile?.countryCode} /><Fact label="地址" value={supplierAddress} /><Fact localize={["local", "import", "unclassified"].includes(asText(supplierProfile?.route, ""))} label="采购路线" value={({ local: "本地采购", import: "进口采购", unclassified: "未分类" } as Record<string, string>)[asText(supplierProfile?.route, "")] ?? supplierProfile?.route} /><Fact localize={["manufacturer", "distributor", "service", "other"].includes(asText(supplierProfile?.supplierType, ""))} label="供应商类型" value={({ manufacturer: "制造商", distributor: "分销商", service: "服务商", other: "其他" } as Record<string, string>)[asText(supplierProfile?.supplierType, "")] ?? supplierProfile?.supplierType} /><Fact label="行业" value={supplierProfile?.industry} /><Fact label="主要物料" value={supplierProfile?.primaryMaterialName ?? supplierProfile?.primaryMaterialCode} /><Fact localize label="默认交付周期" value={supplierProfile?.defaultLeadTimeDays === null || supplierProfile?.defaultLeadTimeDays === undefined ? "—" : `${supplierProfile.defaultLeadTimeDays} 天`} /><Fact localize={["high", "medium", "low", "unclassified"].includes(asText(supplierProfile?.productCriticality, ""))} label="物料关键程度" value={({ high: "高", medium: "中", low: "低", unclassified: "未分类" } as Record<string, string>)[asText(supplierProfile?.productCriticality, "")] ?? supplierProfile?.productCriticality} /><Fact label="付款条款" value={supplierProfile?.paymentTerms} /><Fact label="合同期限" value={supplierProfile?.contractStartsOn || supplierProfile?.contractEndsOn ? `${asText(supplierProfile.contractStartsOn, "—")} — ${asText(supplierProfile.contractEndsOn, "—")}` : "—"} /></div></div>
        <div className="rounded-xl border border-slate-200 p-4"><div className="text-xs font-semibold text-slate-800">供应商联系人</div>{supplierContacts.length ? <div className="mt-3 space-y-2">{supplierContacts.map((contact, index) => <div key={asText(contact.id, String(index))} className="grid gap-2 rounded-lg bg-slate-50 p-3 text-[11px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]"><div><div className="font-semibold text-slate-800"><TextValue value={contact.name} fallback={`联系人 ${index + 1}`} />{contact.primary === true ? <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-[9px] text-blue-700">主联系人</span> : null}</div><div className="mt-1 text-slate-400"><TextValue value={contact.role} fallback="角色未记录" /></div></div><div className="break-all text-slate-600"><TextValue value={contact.email} fallback="邮箱未记录" /><div className="mt-1"><TextValue value={contact.phone} fallback="电话未记录" /></div></div></div>)}</div> : <div className="mt-3 rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400">{supplierContactsRecorded ? "当前供应商主数据明确没有可用联系人记录" : "当前上下文未提供供应商联系人集合"}</div>}</div>{confirmation ? <div className="rounded-xl border border-slate-200 p-4"><div className="flex items-center justify-between gap-3"><div className="text-xs font-semibold text-slate-800">最新结构化订单确认</div><Badge tone={badgeTone(confirmation.status)}><StatusValue value={confirmation.status} /></Badge></div><div className="mt-3 grid grid-cols-2 gap-3"><Fact label="供应商参考" value={confirmation.supplierReference} /><Fact localize label="确认时间" value={formatTime(confirmation.confirmedAt ?? confirmation.updatedAt)} /></div>{confirmationLines.length ? <div className="mt-3 space-y-2">{confirmationLines.map((line, index) => <div key={asText(line.id, String(index))} className="rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600"><div className="font-medium text-slate-800"><TextValue value={hasDataText(line.description) ? line.description : line.itemId} fallback={`行 ${index + 1}`} /></div><div className="mt-2 grid grid-cols-2 gap-2"><span>确认数量：{asNumber(line.confirmedQty) ?? "—"}</span><span>单价差：{formatVariance(line.unitPriceVariance)}</span><span>交期：{formatDate(line.promisedAt)}</span><span>交期差：{formatVariance(line.promisedAtVarianceDays, " 天")}</span></div></div>)}</div> : <div className="mt-3 text-xs text-slate-400">确认单尚无可读行记录</div>}</div> : <div className="rounded-xl border border-dashed border-slate-200 px-3 py-8 text-center text-xs text-slate-400">尚未形成供应商结构化确认</div>}
      </>}</div>}

      {tab === "documents" && <div className="space-y-5">
        <PoTabMetrics title="文档统计" values={[
          { label: "文档总数", value: documentKpis?.total }, { label: "已核验文档", value: documentKpis?.verified },
          { label: "待审核", value: documentKpis?.pending }, { label: "缺失文档", value: documentKpis?.missing },
        ]} />
        <div className={cn("grid grid-cols-1 items-start gap-5", selectedDocument && "xl:grid-cols-[minmax(0,1fr)_340px]")}>
          <section className={cn(poTabCardClass, "overflow-hidden")}>
            <div className="flex flex-col gap-3 px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
              <div><h3 className="text-[15px] font-semibold text-[#13203a]">文档（{documentRows.length}）</h3><p className="mt-0.5 text-[13px] text-slate-400">与此采购订单相关的全部文档</p></div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="relative min-w-0"><span className="sr-only">搜索文档</span><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><input aria-label="搜索文档" value={documentSearch} onChange={(event) => setDocumentSearch(event.target.value)} placeholder="搜索文档…" className="h-9 w-[190px] max-w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-[13px] outline-none focus:border-blue-400" /></label>
                <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600 shadow-sm transition hover:bg-slate-50"><SlidersHorizontal className="size-4" />筛选</button>
                <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600 shadow-sm transition hover:bg-slate-50">分类<ChevronDown className="size-3.5 opacity-60" /></button>
              </div>
            </div>
            {documentRows.length ? <>
              <div className="max-w-full overflow-x-auto">
                <table className="w-full min-w-[820px] border-collapse text-left">
                  <thead><tr className="border-y border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{["文档名称", "分类", "上传人", "上传时间", "状态", "文件大小", "操作"].map((label) => <th key={label} className="whitespace-nowrap px-4 py-3">{label}</th>)}</tr></thead>
                  <tbody>{visibleDocumentRows.map((document) => {
                    const key = asText(document.snapshotId, asText(document.id));
                    const safeDocumentUrl = documentOpenHref(document.url);
                    const status = documentStatusView(document);
                    const selected = selectedDocumentKey === key;
                    return <tr key={key} tabIndex={0} aria-selected={selected} onClick={() => setSelectedDocumentKey(key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedDocumentKey(key); } }} className={cn("cursor-pointer border-b border-slate-100 text-[13px] text-slate-600 transition hover:bg-blue-50/40 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-300", selected && "bg-blue-50/60")}>
                      <td className="max-w-[260px] px-4 py-3"><span className="flex items-center gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-500"><FileText className="size-4" /></span><span data-preserve-language className="block break-words font-medium text-slate-800">{asText(document.name, asText(document.id, "—"))}</span></span></td>
                      <td data-preserve-language={documentCategoryLabels[asText(document.category, "")] ? undefined : true} className="px-4 py-3">{documentCategoryLabel(document.category, asText(document.requirementLabel, ""))}</td>
                      <td data-preserve-language className="whitespace-nowrap px-4 py-3">{asText(document.createdBy, asText(document.uploadedBy, "—"))}</td>
                      <td className="whitespace-nowrap px-4 py-3">{document.createdAt || document.uploadedAt ? formatTime(document.createdAt ?? document.uploadedAt) : "—"}</td>
                      <td className="px-4 py-3"><Badge tone={status.tone}>{status.label}</Badge></td>
                      <td className="whitespace-nowrap px-4 py-3 tabular-nums">{formatBytes(asNumber(document.sizeBytes) ?? asNumber(document.size))}</td>
                      <td className="px-4 py-3" onClick={(event) => event.stopPropagation()}>{safeDocumentUrl ? <a aria-label={`下载 ${asText(document.name, "文档")}`} href={safeDocumentUrl} target="_blank" rel="noopener noreferrer" className="flex size-7 items-center justify-center rounded-lg text-blue-600 transition hover:bg-blue-50"><FileText className="size-4" /></a> : <button type="button" disabled aria-label="文档下载不可用" className="flex size-7 cursor-not-allowed items-center justify-center rounded-lg text-slate-300"><FileText className="size-4" /></button>}</td>
                    </tr>;
                  })}</tbody>
                </table>
              </div>
              <div className="flex items-center justify-between px-5 py-4"><p className="text-[13px] text-slate-400">显示 1 至 {visibleDocumentRows.length}，共 {documentRows.length} 份文档</p></div>
            </> : <div className="flex min-h-[236px] flex-col items-center justify-center gap-2 px-6 py-16 text-center"><span className="flex size-11 items-center justify-center rounded-xl bg-slate-100 text-slate-400"><FileText className="size-5" /></span><p className="text-[14px] font-medium text-slate-800">此订单暂无文档。</p><p className="max-w-[380px] text-[13px] text-slate-400">仅保存此功能启用后创建或关联的采购订单附件。</p></div>}
          </section>
          {selectedDocument ? (() => {
            const status = documentStatusView(selectedDocument);
            const safeDocumentUrl = documentOpenHref(selectedDocument.url);
            return <aside data-document-detail className={cn(poTabCardClass, "p-5")}>
              <div className="flex items-start justify-between gap-2"><h3 data-preserve-language className="text-[14px] font-semibold leading-snug text-slate-800">{asText(selectedDocument.name, asText(selectedDocument.id, "—"))}</h3><button type="button" aria-label="关闭文档详情" onClick={() => setSelectedDocumentKey(null)} className="flex size-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"><X className="size-4" /></button></div>
              <div className="mt-4 flex items-center gap-4"><span className="flex h-16 w-14 items-center justify-center rounded-xl bg-red-50 text-red-500"><FileText className="size-7" /></span><dl className="flex-1 space-y-1 text-[12px]">
                {([ ["分类", documentCategoryLabel(selectedDocument.category, asText(selectedDocument.requirementLabel, ""))], ["上传人", asText(selectedDocument.createdBy, asText(selectedDocument.uploadedBy, "—"))], ["上传时间", selectedDocument.createdAt || selectedDocument.uploadedAt ? formatTime(selectedDocument.createdAt ?? selectedDocument.uploadedAt) : "—"], ["文件类型", asText(selectedDocument.detectedContentType, asText(selectedDocument.contentType, asText(selectedDocument.fileType, "—")))], ["文件大小", formatBytes(asNumber(selectedDocument.sizeBytes) ?? asNumber(selectedDocument.size))], ["状态", status.label] ] as Array<[string, string]>).map(([label, value]) => <div key={label} className="flex justify-between gap-3"><dt className="text-slate-400">{label}</dt><dd data-preserve-language={label === "分类" ? (documentCategoryLabels[asText(selectedDocument.category, "")] ? undefined : true) : label === "状态" ? (["missing", "verified", "pending", "under_review", "security_blocked", "expired"].includes(asText(selectedDocument.status, "")) || typeof selectedDocument.verified === "boolean" ? undefined : true) : label === "文件大小" || label === "上传时间" ? undefined : true} className="text-right font-medium text-slate-800">{value}</dd></div>)}
              </dl></div>
              <div className="mt-5">{safeDocumentUrl ? <a href={safeDocumentUrl} target="_blank" rel="noopener noreferrer" className="flex h-10 w-full items-center justify-center rounded-xl bg-blue-600 text-sm font-semibold text-white transition hover:bg-blue-700">下载</a> : <button type="button" disabled className="h-10 w-full cursor-not-allowed rounded-xl bg-slate-100 text-sm font-semibold text-slate-400">下载不可用</button>}</div>
            </aside>;
          })() : null}
        </div>
        {documentRequirements.some((requirement) => requirement.required === true && requirement.state === "missing") ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3"><div className="text-xs font-semibold text-amber-800">缺少必需文档</div><div className="mt-2 flex flex-wrap gap-2">{documentRequirements.filter((requirement) => requirement.required === true && requirement.state === "missing").map((requirement) => <span data-preserve-language={documentCategoryLabels[asText(requirement.id, "")] ? undefined : true} key={asText(requirement.id)} className="rounded-full border border-amber-200 bg-white px-2.5 py-1 text-[10px] font-semibold text-amber-700">{documentCategoryLabel(requirement.id, asText(requirement.label))}</span>)}</div></div> : null}
        {(detail?.invoices?.length || detail?.productionProgress?.length || fulfilmentEvidence.length || detail?.transportEvents?.length || detail?.attachments?.length) ? <details className={cn(poTabCardClass, "p-5")}><summary className="cursor-pointer text-sm font-semibold text-slate-800">业务证据与附件</summary><div className="mt-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border border-slate-200 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-slate-800"><PackageCheck className="size-4 text-slate-400" />采购订单</div><div className="mt-3 grid grid-cols-2 gap-3"><Fact label="PO 号" value={po.displayNumber ?? po.number ?? po.externalId ?? po.id} mono /><Fact localize={!!statusNames[asText(po.status, "")]} label="状态" value=<StatusValue value={po.status} /> /><Fact label="供应商" value={supplier?.name ?? po.supplierId} /><Fact label="币种" value={po.currency} /></div></div><div className="rounded-xl border border-slate-200 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-slate-800"><FileText className="size-4 text-slate-400" />发票 / 三单匹配</div>{detail?.invoices?.length ? <div className="mt-3 space-y-2">{detail.invoices.map((invoice) => <div key={asText(invoice.id)} className="rounded-lg bg-slate-50 p-2"><div className="text-xs font-medium text-slate-800">{asText(invoice.invoiceNumber, compactId(invoice.id))}</div><div className="mt-1 text-[11px] text-slate-500"><StatusValue value={invoice.status} /> · {asText(invoice.currency)}</div></div>)}</div> : <div className="mt-5 text-xs text-slate-400">尚未收到关联发票</div>}</div></div>
        {detail?.productionProgress?.length ? <div><div className="mb-2 text-xs font-semibold text-slate-800">生产 / 备货进度</div><div className="space-y-2">{detail.productionProgress.map((progress) => { const labels: Record<string,string> = { materials_ready: "物料已齐备", in_production: "生产中", quality_check: "质量检验", ready_to_ship: "待发运", delayed: "延期", blocked: "受阻" }; const blocked = ["delayed","blocked"].includes(asText(progress.overallStatus, "")); const progressLines = detail.linesByDocument?.[asText(progress.id, "")] ?? rows(progress.lines); return <div key={asText(progress.id)} className={cn("rounded-xl border p-3", blocked ? "border-red-200 bg-red-50/40" : "border-slate-200")}><div className="flex items-start justify-between gap-3"><div><div className="text-xs font-semibold text-slate-800">{asText(progress.externalId, compactId(progress.id))}</div><div className="mt-1 text-[11px] text-slate-500">{formatTime(progress.reportedAt)} · {labels[asText(progress.overallStatus, "")] ?? asText(progress.overallStatus)}</div></div><Badge tone={blocked ? "red" : "violet"}>{blocked ? "风险" : "人工核验"}</Badge></div>{progressLines.length ? <div className="mt-3 space-y-2">{progressLines.map((line) => <div key={asText(line.id)} className="grid gap-2 rounded-lg bg-white/85 p-2 text-[11px] sm:grid-cols-[minmax(0,1fr)_72px_90px]"><span className="truncate font-medium text-slate-700"><TextValue value={hasDataText(line.description) ? line.description : line.itemId} /></span><span>{asNumber(line.completionPercent) ?? 0}%</span><span>{asNumber(line.completedQty) ?? 0} {asText(line.uom, "")}</span><span className="sm:col-span-3 text-slate-500">预计可发运：{line.expectedReadyAt ? formatTime(line.expectedReadyAt) : "未提供"}{line.note ? <> · <TextValue value={line.note} /></> : null}</span></div>)}</div> : null}<div className="mt-3 grid gap-3 rounded-lg bg-violet-50 p-3 sm:grid-cols-2"><Fact label="原始核验依据" value={progress.evidenceReference} /><Fact label="核验人" value={progress.verifiedBy} /><div className="sm:col-span-2"><Fact label="核验原因" value={progress.verificationReason} /></div></div></div>; })}</div></div> : null}
        {fulfilmentEvidence.length ? <div><div className="mb-2 text-xs font-semibold text-slate-800">发运 / GRN 事实来源</div><div className="space-y-2">{fulfilmentEvidence.map(({ document, kind }) => { const manual = document.evidenceSource === "manual_verified" || document.sourceSystem === "readywork-manual-verification"; const shipment = kind === "shipment"; return <div key={`${kind}:${asText(document.id)}`} className="rounded-xl border border-slate-200 p-3"><div className="flex items-start justify-between gap-3"><div><div className="text-xs font-semibold text-slate-800">{asText(document.externalId, compactId(document.id))}</div><div className="mt-1 text-[11px] text-slate-500">{shipment ? "ASN / 发运" : "GRN / 收货"} · {formatTime(shipment ? document.shippedAt : document.receivedAt)}</div></div><Badge tone={manual ? "violet" : "blue"}>{manual ? "人工核验" : asText(document.sourceSystem, "连接器")}</Badge></div>{shipment ? <div className="mt-3 grid gap-3 rounded-lg bg-blue-50/70 p-3 sm:grid-cols-3"><Fact label="承运商" value={document.carrier} /><Fact label="运单号" value={document.trackingNumber} /><Fact label="ETA" value={document.estimatedArrivalAt ? formatTime(document.estimatedArrivalAt) : "未提供"} /></div> : null}{manual ? <div className="mt-3 grid gap-3 rounded-lg bg-violet-50 p-3 sm:grid-cols-2"><Fact label="原始核验依据" value={document.evidenceReference} /><Fact label="核验人" value={document.verifiedBy} /><div className="sm:col-span-2"><Fact label="核验原因" value={document.verificationReason} /></div></div> : null}</div>; })}</div></div> : null}
        {detail?.transportEvents?.length ? <div><div className="mb-2 text-xs font-semibold text-slate-800">运输 / 清关节点</div><div className="space-y-2">{detail.transportEvents.map((event) => { const labels: Record<string,string> = { picked_up: "已揽收", departed_origin: "已离开发运地", arrived_port: "已抵达口岸", customs_submitted: "已提交清关", customs_cleared: "已完成清关", customs_held: "清关受阻", out_for_delivery: "派送中", delivered: "承运商已送达", exception: "运输异常" }; const blocked = ["customs_held","exception"].includes(asText(event.eventCode, "")); return <div key={asText(event.id)} className={cn("rounded-xl border p-3", blocked ? "border-red-200 bg-red-50/40" : "border-slate-200")}><div className="flex items-start justify-between gap-3"><div><div className="text-xs font-semibold text-slate-800">{labels[asText(event.eventCode, "")] ?? asText(event.eventCode, "运输节点")}</div><div className="mt-1 text-[11px] text-slate-500">{formatTime(event.occurredAt)} · {asText(event.location, "位置未提供")}</div></div><Badge tone={blocked ? "red" : "blue"}>{blocked ? "风险" : "已核验"}</Badge></div><div className="mt-3 grid gap-3 rounded-lg bg-white/80 p-3 sm:grid-cols-3"><Fact label="证据编号" value={event.externalId} /><Fact label="承运商参考" value={event.carrierReference} /><Fact label="更新 ETA" value={event.estimatedArrivalAt ? formatTime(event.estimatedArrivalAt) : "未更新"} /></div><div className="mt-3 grid gap-3 rounded-lg bg-violet-50 p-3 sm:grid-cols-2"><Fact label="原始核验依据" value={event.evidenceReference} /><Fact label="核验人" value={event.verifiedBy} /></div></div>; })}</div></div> : null}
        <div><div className="mb-2 text-xs font-semibold text-slate-800">相关附件</div>{detail?.attachments?.length ? <div className="space-y-2">{detail.attachments.map((attachment, index) => <SafeAttachment key={attachment.id ?? index} attachment={attachment} />)}</div> : null}</div>
        </div></details> : null}
      </div>}

      {tab === "history" && <div className="space-y-5">
        <PoTabMetrics title="历史统计" values={[
          { label: "活动总数", value: auditEvents.length }, { label: "创建日期", value: formatDate(po.createdAt ?? po.orderedAt) },
          { label: "最近更新", value: formatDate(po.updatedAt) }, { label: "当前阶段", value: stageDisplayLabel(currentStage), localizeValue: !!stageLabels[currentStage?.id ?? ""] },
        ]} />
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section className={cn(poTabCardClass, "min-h-[330px] p-6")}>
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-[15px] font-semibold text-[#13203a]">历史时间线</h3><p className="mt-1 text-xs text-slate-400">查看此采购订单已记录的活动与变更。</p></div><div className="flex items-center gap-2"><button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600 shadow-sm transition hover:bg-slate-50"><SlidersHorizontal className="size-4" />筛选</button><button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600 shadow-sm transition hover:bg-slate-50">全部活动<ChevronDown className="size-3.5 opacity-60" /></button></div></div>
        <div>{auditEvents.length ? <div className="space-y-0">{auditEvents.map((event) => <div key={`${event.source}:${event.id}`} className="grid grid-cols-[38px_12px_minmax(0,1fr)] gap-x-2 pb-5 last:pb-0"><span className="text-[10px] text-[#718198]">{formatTime(event.at).slice(-5)}</span><span className="relative flex justify-center before:absolute before:bottom-[-20px] before:top-3 before:w-px before:bg-[#dbe3ee] last:before:hidden"><span className={cn("relative z-10 mt-1 size-2.5 rounded-full border-2 border-white ring-1 ring-[#dbe3ee]", event.state === "failed" || event.state === "blocked" ? "bg-[#f04444]" : event.state === "dispatched" || event.state === "completed" ? "bg-emerald-500" : "bg-[#91a0b4]")} /></span><span className="min-w-0"><span data-preserve-language={event.preserveTitle ? true : undefined} className="block text-xs font-semibold leading-5 text-[#13203a]">{event.title}</span><span data-preserve-language={"preserveMeta" in event && event.preserveMeta ? true : undefined} className="mt-0.5 block text-[11px] leading-4 text-[#64748b]">{event.meta}</span>{event.summary ? <span data-preserve-language className="mt-1 block whitespace-pre-wrap break-words text-[11px] leading-5 text-[#64748b]">{event.summary}</span> : null}</span></div>)}</div> : <div className="rounded-xl border border-dashed border-slate-200 px-3 py-8 text-center"><History className="mx-auto size-6 text-slate-200" /><div className="mt-2 text-xs text-slate-400">暂无历史记录</div></div>}</div>
          </section>
          <aside className="space-y-5">
            <section className={cn(poTabCardClass, "p-6")}><h3 className="text-[15px] font-semibold text-[#13203a]">采购订单详情</h3><div className="mt-5 grid gap-4"><Fact label="订单编号" value={poDisplayNumber} /><Fact label="供应商" value={supplier?.name ?? po.supplierName ?? po.supplierId} /><Fact localize={!!statusNames[asText(po.status, "")]} label="订单状态" value=<StatusValue value={po.status} /> /><Fact localize label="要求到厂日期" value={formatDate(po.requiredInHouseAt ?? firstLine?.requestedAt)} /><Fact localize={!!stageLabels[currentStage?.id ?? ""]} label="当前阶段" value={stageDisplayLabel(currentStage)} /></div></section>
            <section className={cn(poTabCardClass, "p-6")}><h3 className="mb-5 text-[15px] font-semibold text-[#13203a]">阶段时间线</h3><StageTimeline stages={detail?.stageTimeline ?? []} compact /></section>
          </aside>
        </div>
        {(matchedSlaRules.length || detail?.executionApprovals?.length || detail?.approvals?.length) ? <details className={cn(poTabCardClass, "p-5")} open={Boolean(pendingApproval || detail?.approvals?.some((approval) => approval.status === "pending"))}><summary className="cursor-pointer text-sm font-semibold text-slate-800">审批与 SLA 依据</summary><div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-slate-200 p-3"><div className="flex items-center gap-2 text-xs font-semibold text-slate-800"><ShieldCheck className="size-4 text-slate-400" />实际命中的 SLA 规则</div>{matchedSlaRules.length ? <div className="mt-3 space-y-2">{matchedSlaRules.map((rule, index) => <div key={`${rule.ruleId}:${index}`} className="grid gap-2 rounded-lg bg-slate-50 p-3 text-[11px] sm:grid-cols-[minmax(0,1fr)_auto]"><div><div className="font-semibold text-slate-800">{rule.stage}</div><div className="mt-1 font-mono text-slate-500">{rule.ruleId}</div></div><div className="text-right text-slate-500">v{rule.policyVersion ?? "—"}<div className="mt-1"><StatusValue value={rule.status} /></div></div></div>)}</div> : <div className="mt-3 rounded-lg border border-dashed border-slate-200 px-3 py-5 text-center text-xs text-slate-400">当前阶段事实没有关联已发布 SLA 规则，因此不展示推测规则。</div>}</div>
        <div className="rounded-xl border border-slate-200 p-3"><div className="text-xs font-semibold text-slate-800">审批身份与记录</div><div className="mt-3 space-y-2">{[...(detail?.executionApprovals ?? []), ...(detail?.approvals ?? [])].length ? [...(detail?.executionApprovals ?? []), ...(detail?.approvals ?? [])].map((approval) => <div key={asText(approval.id)} className="rounded-lg bg-slate-50 p-2"><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-medium text-slate-800">{asText(approval.title, asText(approval.kind, "采购审批"))}</span><Badge tone={badgeTone(approval.status)}><StatusValue value={approval.status} /></Badge></div><div className="mt-1 text-[11px] text-slate-400">{asText(approval.decidedBy, asText(approval.requestedBy, "身份将在决策时绑定"))}</div></div>) : <div className="text-xs text-slate-400">暂无审批记录</div>}</div></div>
        </div></details> : null}
      </div>}

      {tab === "communication" && <div className="space-y-5">
        <PoTabMetrics title="沟通统计" values={[
          { label: "Readywork 发出", value: communicationKpis?.outbound },
          { label: "已接收", value: communicationKpis?.inbound },
          { label: "待审草稿", value: communicationKpis?.pendingDrafts },
        ]} />
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section className={cn(poTabCardClass, "min-h-[540px] p-4")}>
            <div className="mb-4 flex items-center justify-between gap-3 border-b border-slate-100 pb-4"><h3 className="text-sm font-semibold text-[#13203a]">对话</h3><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-500">{visibleCommunications.length} 条消息</span></div>
{visibleCommunications.length ? <div className="space-y-3">{visibleCommunications.map((message, index) => { const inbound = message.direction === "inbound"; return <article data-po-message key={asText(message.id, String(index))} className="rounded-xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div data-preserve-language={hasDataText(message.subject) ? true : undefined} className="truncate text-xs font-semibold text-slate-800">{asText(message.subject, "无主题")}</div><div className="mt-1 break-all text-[11px] text-slate-400"><TextValue value={inbound ? message.from : hasDataText(message.to) ? message.to : message.from} fallback={inbound ? "发件人未记录" : "收件人未记录"} /> · <TextValue value={message.channel} fallback="email" /> · {formatTime(message.receivedAt ?? message.occurredAt ?? message.createdAt)}</div></div><Badge tone={inbound ? "blue" : "violet"}>{inbound ? "收件" : "发件"}</Badge></div>{message.body ? <div data-preserve-language className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-600">{asText(message.body)}</div> : <div className="mt-3 rounded-lg border border-dashed border-slate-200 px-3 py-4 text-xs text-slate-400">当前授权上下文只提供沟通元数据，未提供正文。</div>}<div className="mt-3 grid gap-2 text-[10px] text-slate-400 sm:grid-cols-2"><span>Message-ID：<TextValue value={message.messageId} fallback="未提供" /></span><span>In-Reply-To：<TextValue value={message.inReplyTo} fallback="未提供" /></span></div>{inbound && message.channel === "email" ? <div className="mt-3"><AiSupplierReplyAnalysis analysis={message.aiAnalysis} communicationId={asText(message.id)} subject={asText(message.subject)} canOperate={permissions.operate === true} /></div> : null}</article>; })}</div> : <div className="py-14 text-center"><Inbox className="mx-auto size-7 text-slate-200" /><div className="mt-3 text-sm text-slate-400">{selectedThreadId ? "此线程暂无可见消息" : "此订单暂无消息。与供应商往来的消息将显示在这里。"}</div></div>}
          </section>
          <aside className="space-y-5"><section className={cn(poTabCardClass, "p-6")}><h3 className="text-[15px] font-semibold text-[#13203a]">沟通详情</h3><div className="mt-5 grid gap-4"><Fact label="订单编号" value={poDisplayNumber} /><Fact label="供应商" value={supplier?.name ?? po.supplierName ?? po.supplierId} /><Fact label="消息总数" value={communicationKpis?.total} /><Fact localize label="最近沟通" value={communications.length ? formatTime(communications[0]?.receivedAt ?? communications[0]?.occurredAt ?? communications[0]?.createdAt) : "暂无消息"} /></div></section></aside>
        </div>
        <section aria-label="相关线程" className={cn(poTabCardClass, "p-6")}><div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-[15px] font-semibold text-slate-800">相关线程</h3>{selectedThreadId ? <button type="button" onClick={() => setSelectedThreadId(null)} className="text-[10px] font-semibold text-blue-600 hover:underline">全部消息</button> : null}</div>{relatedThreads.length ? <div className="space-y-2">{relatedThreads.map((thread) => <button type="button" aria-pressed={selectedThreadId === asText(thread.id)} key={asText(thread.id)} onClick={() => setSelectedThreadId(asText(thread.id))} className={cn("flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-3 text-left transition hover:border-blue-300 hover:bg-blue-50/40", selectedThreadId === asText(thread.id) && "border-blue-400 bg-blue-50")}><span className="min-w-0"><span data-preserve-language={hasDataText(thread.subject) ? true : undefined} className="block truncate text-xs font-semibold text-slate-800">{asText(thread.subject, "无主题")}</span><span className="mt-1 block truncate font-mono text-[10px] text-slate-400">{asText(thread.id)}</span></span><span className="shrink-0 text-[10px] font-semibold text-slate-500">{asNumber(thread.messageCount) ?? "—"} 条消息</span></button>)}</div> : <div className="rounded-xl border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400">暂无关联线程</div>}</section>
        {detail?.outbox?.length ? <div><div className="mb-3 text-xs font-semibold text-slate-800">连接器 / Outbox 回执</div><div className="space-y-2">{detail.outbox.map((entry, index) => <div key={asText(entry.id, String(index))} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-3"><div className="min-w-0"><div className="truncate text-xs font-semibold text-slate-700">{executionNames[asText(entry.action, "")] ?? asText(entry.action, "外发动作")}</div><div className="mt-1 text-[10px] text-slate-400">{asText(entry.channel, "渠道未记录")} · {formatTime(entry.dispatchedAt ?? entry.updatedAt ?? entry.createdAt)} · 尝试 {asNumber(entry.attempts) ?? 0}</div></div><Badge tone={badgeTone(entry.status)}><StatusValue value={entry.status} /></Badge></div>)}</div></div> : null}
        <PoContextChat purchaseOrderId={asText(po.id)} canOperate={permissions.operate === true} availableActionIds={actions.map((action) => action.id)} onOpenSuggestedAction={openChatSuggestedAction} />
      </div>}
      </>}
    </div>
    {pagePresentation ? null : <div className="grid h-[82px] shrink-0 grid-cols-[1fr_1.08fr] gap-4 border-t border-[#e4eaf2] bg-white px-6 py-4"><button type="button" onClick={onClose} className="rounded-xl border border-[#d9e1ec] bg-white text-[15px] font-semibold text-[#26364f] hover:bg-slate-50">暂不处理</button><button type="button" disabled={!selectedAction} onClick={() => selectedAction && onAction(selectedAction)} className="rounded-xl bg-[#071533] text-[15px] font-semibold text-white shadow-sm hover:bg-[#102449] disabled:cursor-not-allowed disabled:opacity-40">批准并继续</button></div>}
  </div>;
}

export function ProcurementPoEmployee(props: {
  onCreateTask?: () => void;
  initialPurchaseOrderId?: string | null;
  initialPurchaseOrderIntent?: PurchaseOrderNavigationIntent | null;
  initialDetailTab?: unknown;
  onInitialPurchaseOrderConsumed?: () => void;
  onInitialPurchaseOrderInvalid?: (purchaseOrderId: string) => void;
  onPurchaseOrderNavigationChange?: (purchaseOrderId: string, tab: DetailTab) => void;
  onReturn?: () => void;
  returnLabel?: string;
  onOpenSettings?: () => void;
  detailPresentation?: "workspace" | "page";
}) {
  const {
    initialPurchaseOrderId,
    initialPurchaseOrderIntent,
    initialDetailTab,
    onInitialPurchaseOrderConsumed,
    onInitialPurchaseOrderInvalid,
    onPurchaseOrderNavigationChange,
    onReturn,
    returnLabel,
    onOpenSettings,
    detailPresentation,
  } = props;
  const { formatShortDateTime, preferences } = useProcurementLocale();
  const { language: interfaceLanguage } = useUiLanguage();
  const formatTime = (value: unknown) => formatShortDateTime(typeof value === "string" ? value : null, "时间未记录");
  const [data, setData] = useState<WorkbenchPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [groupFilter, setGroupFilter] = useState<QueueGroup | "all">("all");
  const [riskFilter, setRiskFilter] = useState<RiskFilter>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ContextPayload | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailVisible, setDetailVisible] = useState(true);
  const [desktopDetailSurface, setDesktopDetailSurface] = useState(false);
  const [tab, setTab] = useState<DetailTab>(() => poDetailTabFromNavigationValue(initialDetailTab) ?? "overview");
  const [confirming, setConfirming] = useState<ActionPlan | null>(null);
  const [editForm, setEditForm] = useState<EditPurchaseOrderForm | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const editSubmittingRef = useRef(false);
  const editReturnFocusRef = useRef<HTMLElement | null>(null);
  const [markAtRiskForm, setMarkAtRiskForm] = useState<MarkAtRiskForm | null>(null);
  const markAtRiskReturnFocusRef = useRef<HTMLElement | null>(null);
  const [markAtRiskSubmitting, setMarkAtRiskSubmitting] = useState(false);
  const [duplicateForm, setDuplicateForm] = useState<DuplicatePurchaseOrderForm | null>(null);
  const [duplicateSubmitting, setDuplicateSubmitting] = useState(false);
  const duplicateSubmittingRef = useRef(false);
  const [cancelForm, setCancelForm] = useState<CancelPurchaseOrderForm | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const cancelSubmittingRef = useRef(false);
  const cancelReturnFocusRef = useRef<HTMLElement | null>(null);
  const cancelReasonRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelStatusRef = useRef<HTMLDivElement | null>(null);
  const unresolvedCancellationsRef = useRef(new Map<string, CancelPurchaseOrderForm>());
  const [reason, setReason] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [verificationReference, setVerificationReference] = useState("");
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [estimatedArrivalAt, setEstimatedArrivalAt] = useState("");
  const [transportEventCode, setTransportEventCode] = useState("picked_up");
  const [transportEventOccurredAt, setTransportEventOccurredAt] = useState("");
  const [transportEventReference, setTransportEventReference] = useState("");
  const [transportLocation, setTransportLocation] = useState("");
  const [carrierReference, setCarrierReference] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [shipmentId, setShipmentId] = useState("");
  const [evidenceQuantities, setEvidenceQuantities] = useState<Record<string, string>>({});
  const [confirmationCommunicationId, setConfirmationCommunicationId] = useState("");
  const [confirmationQuantities, setConfirmationQuantities] = useState<Record<string, string>>({});
  const [confirmationUnitPrices, setConfirmationUnitPrices] = useState<Record<string, string>>({});
  const [confirmationPromisedDates, setConfirmationPromisedDates] = useState<Record<string, string>>({});
  const [productionProgressReference, setProductionProgressReference] = useState("");
  const [productionProgressStatus, setProductionProgressStatus] = useState("in_production");
  const [productionExpectedReadyAt, setProductionExpectedReadyAt] = useState("");
  const [productionNote, setProductionNote] = useState("");
  const [productionQuantities, setProductionQuantities] = useState<Record<string, string>>({});
  const [productionPercentages, setProductionPercentages] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error" | "pending"; text: string; purchaseOrderId?: string } | null>(null);
  const [navigationNotice, setNavigationNotice] = useState<string | null>(null);
  const [resolvedDetailPresentation, setResolvedDetailPresentation] = useState<"workspace" | "page">(
    () => detailPresentation ?? (initialPurchaseOrderId ? "page" : "workspace"),
  );
  const workbenchRequest = useRef<AbortController | null>(null);
  const detailRequest = useRef<AbortController | null>(null);
  const detailDialogRef = useRef<HTMLDivElement | null>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const confirmReturnFocusRef = useRef<HTMLElement | null>(null);
  const duplicateReturnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (detailPresentation) {
      setResolvedDetailPresentation(detailPresentation);
      return;
    }
    if (initialPurchaseOrderId) setResolvedDetailPresentation("page");
  }, [detailPresentation, initialPurchaseOrderId]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const sync = () => setDesktopDetailSurface(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!detailOpen || desktopDetailSurface) return;
    const dialog = detailDialogRef.current;
    if (!dialog) return;
    const returnFocus = detailReturnFocusRef.current
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const focusableSelector = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusableItems = () => [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    const animationFrame = window.requestAnimationFrame(() => {
      (dialog.querySelector<HTMLElement>("[data-detail-initial-focus]") ?? focusableItems()[0] ?? dialog).focus();
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusableItems();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      dialog.removeEventListener("keydown", trapFocus);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [desktopDetailSurface, detailOpen]);

  const loadWorkbench = useCallback(async (quiet = false, timeoutMs = 15_000): Promise<WorkbenchPayload | null> => {
    workbenchRequest.current?.abort();
    const controller = new AbortController();
    workbenchRequest.current = controller;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const payload = await apiRequest<WorkbenchPayload>("/api/procurement/workbench?limit=100", { signal: controller.signal, timeoutMs });
      if (!controller.signal.aborted) setData(payload);
      return controller.signal.aborted ? null : payload;
    } catch (cause) {
      if (!controller.signal.aborted && !(cause instanceof ReadyworkApiError && cause.status === 499)) setError(errorMessage(cause));
      return null;
    } finally {
      if (workbenchRequest.current === controller) {
        // A quiet refresh can replace the initial read. The current request
        // owns completion even when its predecessor turned the spinner on.
        if (!controller.signal.aborted) setLoading(false);
        workbenchRequest.current = null;
      }
    }
  }, []);

  const loadDetail = useCallback(async (id: string, quiet = false) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    if (!quiet) { setDetailLoading(true); setDetail(null); }
    setDetailError(null);
    try {
      const payload = await apiRequest<ContextPayload>(`/api/procurement/workbench/context/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (!controller.signal.aborted) setDetail(payload);
    } catch (cause) {
      if (!controller.signal.aborted && !(cause instanceof ReadyworkApiError && cause.status === 499)) setDetailError(errorMessage(cause));
    } finally {
      if (detailRequest.current === controller) {
        if (!controller.signal.aborted) setDetailLoading(false);
        detailRequest.current = null;
      }
    }
  }, []);

  useProcurementRealtimeRefresh(["pos", "outbox", "messages", "notifications"], () => {
    void loadWorkbench(true);
    if (selectedId) void loadDetail(selectedId, true);
  }, 250);

  useEffect(() => {
    void loadWorkbench();
    const timer = window.setInterval(() => void loadWorkbench(true), 60_000);
    return () => {
      window.clearInterval(timer);
      workbenchRequest.current?.abort();
      detailRequest.current?.abort();
    };
  }, [loadWorkbench]);

  const queue = useMemo<QueueItem[]>(() => {
    const purchaseOrders = data?.documents?.purchaseOrders?.items ?? [];
    const portfolioByPo = new Map((data?.portfolio?.items ?? []).map((item) => [asText(item.id, ""), item]));
    const tasks = data?.tasks?.items ?? [];
    const approvals = data?.approvals?.items ?? [];
    const executionApprovals = data?.executionApprovals?.items ?? [];
    const exceptions = data?.exceptions?.items ?? [];
    return purchaseOrders.map((document) => {
      const po = { ...document, ...(portfolioByPo.get(asText(document.id, "")) ?? {}) };
      const relatedTasks = tasks.filter((task) => task.businessObjectId === po.id);
      const taskIds = new Set(relatedTasks.map((task) => task.id));
      const relatedApprovals = [
        ...approvals.filter((approval) => taskIds.has(approval.taskId)),
        ...executionApprovals.filter((approval) => approval.poId === po.id && approval.status === "pending"),
      ];
      const relatedExceptions = exceptions.filter((exception) => exception.objectId === po.id);
      return { po, tasks: relatedTasks, approvals: relatedApprovals, exceptions: relatedExceptions, group: classify(po, relatedTasks, relatedApprovals, relatedExceptions) };
    }).sort((left, right) => groupMeta[left.group].order - groupMeta[right.group].order || String(right.po.updatedAt ?? "").localeCompare(String(left.po.updatedAt ?? "")));
  }, [data]);

  const filteredQueue = useMemo(() => queue.filter((item) => {
    if (groupFilter !== "all" && item.group !== groupFilter) return false;
    if (riskFilter !== "all" && riskLevel(item) !== riskFilter) return false;
    const query = search.trim().toLowerCase();
    return !query || JSON.stringify(item).toLowerCase().includes(query);
  }), [groupFilter, queue, riskFilter, search]);

  useEffect(() => {
    if (!filteredQueue.length) { setSelectedId(null); setDetail(null); return; }
    if (!selectedId || !filteredQueue.some((item) => item.po.id === selectedId)) setSelectedId(asText(filteredQueue[0]!.po.id));
  }, [filteredQueue, selectedId]);

  useEffect(() => {
    if (!initialPurchaseOrderId || loading || !data) return;
    const requestedId = initialPurchaseOrderId;
    const target = queue.find((item) => [item.po.id, item.po.displayNumber, item.po.number, item.po.externalId]
      .some((candidate) => asText(candidate, "") === requestedId));
    if (!target) {
      setNavigationNotice(`链接中的采购订单 ${initialPurchaseOrderId} 不在当前真实订单工作集中；它可能已删除、归档或超出当前读取范围。系统已清除失效目标，不会在后续导航中重放该链接。`);
      onInitialPurchaseOrderInvalid?.(initialPurchaseOrderId);
      return;
    }
    const resolvedId = asText(target.po.id);
    setNavigationNotice(null);
    setSearch("");
    setGroupFilter("all");
    setRiskFilter("all");
    const resolvedDetailTab = poDetailTabFromNavigationValue(initialDetailTab) ?? "overview";
    setTab(resolvedDetailTab);
    setSelectedId(resolvedId);
    setDetailOpen(!desktopDetailSurface);
    setDetailVisible(true);
    if (resolvedId !== requestedId) onPurchaseOrderNavigationChange?.(resolvedId, resolvedDetailTab);
    if (!initialPurchaseOrderIntent) onInitialPurchaseOrderConsumed?.();
  }, [data, desktopDetailSurface, initialDetailTab, initialPurchaseOrderId, initialPurchaseOrderIntent, loading, onInitialPurchaseOrderConsumed, onInitialPurchaseOrderInvalid, onPurchaseOrderNavigationChange, queue]);

  useEffect(() => {
    if (!selectedId) return;
    // A duplicate result belongs to the new order; retain it through the
    // authoritative context load, but never show it on another order.
    setFeedback((current) => current?.purchaseOrderId === selectedId ? current : null);
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  const selected = queue.find((item) => item.po.id === selectedId) ?? filteredQueue[0] ?? null;
  const selectDetailTab = useCallback((nextTab: DetailTab) => {
    setTab(nextTab);
    if (selectedId) onPurchaseOrderNavigationChange?.(selectedId, nextTab);
  }, [onPurchaseOrderNavigationChange, selectedId]);
  const activeDetail = detail && selectedId && (detail.requestedId === selectedId || detail.objectId === selectedId) ? detail : null;
  useEffect(() => {
    // Inbound mail can arrive even when no outbound task is running. Keep a
    // bounded fallback for missed SSE events and temporary reconnects.
    if (!selectedId) return;
    const timer = window.setInterval(() => { void loadDetail(selectedId, true); void loadWorkbench(true); }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadDetail, loadWorkbench, selectedId]);

  const po = activeDetail?.purchaseOrders?.find((entry) => entry.id === selectedId);
  const poVersion = asNumber(po?.version);
  const pendingExecutionApproval = activeDetail?.executionApprovals?.find((entry) => entry.status === "pending" && entry.kind === "supplier_confirmation");
  const pendingConfirmation = pendingExecutionApproval
    ? activeDetail?.confirmations?.find((entry) => entry.id === pendingExecutionApproval.objectId)
    : undefined;
  const pendingConfirmationLines = pendingConfirmation
    ? activeDetail?.linesByDocument?.[asText(pendingConfirmation.id, "")] ?? rows(pendingConfirmation.lines)
    : [];
  const pendingShortfall = po && pendingConfirmation
    ? buildPoDetailShortfallSummary({
      po,
      lines: activeDetail?.linesByDocument?.[asText(po.id, "")] ?? rows(po.lines),
      quantityProjections: activeDetail?.quantityProjections ?? [],
      confirmationLines: pendingConfirmationLines,
    })
    : undefined;
  const pendingRuntimeApproval = activeDetail?.approvals?.find((entry) => !entry.status || entry.status === "pending");
  const relatedTask = pendingRuntimeApproval ? activeDetail?.tasks?.find((entry) => entry.id === pendingRuntimeApproval.taskId) : undefined;
  const canOperate = data?.permissions?.operate === true;
  const canApprove = data?.permissions?.approve === true;
  const hasUnfinishedSend = activeDetail?.outbox?.some((entry) => entry.action === "purchase_order.send"
    && ["pending", "processing"].includes(String(entry.status ?? ""))) === true;
  const hasUnfinishedOdooCreate = activeDetail?.outbox?.some((entry) => entry.action === "purchase_order.create_draft"
    && ["pending", "processing", "blocked"].includes(String(entry.status ?? ""))) === true;
  const selectedSupplier = activeDetail?.suppliers?.find((entry) => entry.id === po?.supplierId);
  const currentExecutionStage = activeDetail?.stageTimeline?.find((stage) => stage.state === "active" || stage.state === "blocked")?.id
    ?? activeDetail?.stageTimeline?.find((stage) => stage.state === "pending")?.id
    ?? asText(selected?.po.stage, "po_sent");

  const beginDuplicatePurchaseOrder = useCallback((target: DuplicatePurchaseOrderTarget, returnFocusElement?: HTMLElement | null) => {
    duplicateReturnFocusRef.current = returnFocusElement ?? null;
    const suffix = "-COPY";
    const baseNumber = target.purchaseOrderNumber.trim().slice(0, 120 - suffix.length) || "PO";
    setDuplicateForm({
      ...target,
      newPurchaseOrderNumber: `${baseNumber}${suffix}`,
      newRequiredInHouseAt: target.requiredInHouseAt ? target.requiredInHouseAt.slice(0, 10) : "",
      reason: "",
      idempotencyKey: duplicatePoIdempotencyKey(target.aggregateId),
      error: null,
    });
    setFeedback(null);
  }, []);

  const beginCancelPurchaseOrder = useCallback((target: CancelPurchaseOrderTarget, returnFocusElement?: HTMLElement | null) => {
    cancelReturnFocusRef.current = returnFocusElement ?? null;
    const unresolved = unresolvedCancellationsRef.current.get(target.aggregateId);
    const persisted = target.existingRequest;
    const recovered: CancelPurchaseOrderForm | null = persisted ? {
      ...target,
      expectedVersion: persisted.sourcePoVersion,
      reason: persisted.reason,
      idempotencyKey: persisted.idempotencyKey,
      error: null,
      result: {
        requestId: persisted.requestId,
        status: cancellationStatusFromPersistedState(persisted.state),
        purchaseOrderVersion: target.expectedVersion,
        outboxId: persisted.outboxId,
      },
    } : null;
    if (recovered && recovered.result?.status !== "cancelled") unresolvedCancellationsRef.current.set(target.aggregateId, recovered);
    setCancelForm(recovered ?? (unresolved
      ? { ...unresolved, blockers: target.blockers, existingRequest: target.existingRequest }
      : { ...target, reason: "", idempotencyKey: cancelPoIdempotencyKey(target.aggregateId), error: null, result: null }));
    setCancelDialogOpen(true);
    setFeedback(null);
  }, []);

  const beginEditPurchaseOrder = useCallback((target: EditPurchaseOrderTarget, returnFocusElement?: HTMLElement | null) => {
    if (!canOperate) { setFeedback({ tone: "error", text: "当前账号没有采购订单操作权限。" }); return; }
    editReturnFocusRef.current = returnFocusElement ?? null;
    setEditForm({ ...target, reason: "", idempotencyKey: editPoIdempotencyKey(target.aggregateId), error: null, serverVersion: null });
    setFeedback(null);
  }, [canOperate]);

  const beginMarkAtRisk = useCallback((target: MarkAtRiskTarget, returnFocusElement?: HTMLElement | null) => {
    if (!canOperate) { setFeedback({ tone: "error", text: "当前账号没有采购订单操作权限。" }); return; }
    markAtRiskReturnFocusRef.current = returnFocusElement ?? null;
    const riskCategory: MarkAtRiskForm["riskCategory"] = target.stage === "supplier_commitment" ? "supplier_response"
      : target.stage === "fulfilment_production" ? "production"
        : target.stage === "dispatch_transit" || target.stage === "delivery_grn" ? "logistics"
          : "schedule";
    setMarkAtRiskForm({
      ...target,
      riskSeverity: "high",
      riskCategory,
      reason: "",
      recommendedAction: "",
      idempotencyKey: `po-risk:${target.aggregateId}:v${target.expectedVersion}:${crypto.randomUUID()}`,
      error: null,
      resultId: null,
    });
    setFeedback(null);
  }, [canOperate]);

  const submitMarkAtRisk = useCallback(async () => {
    if (!markAtRiskForm || markAtRiskSubmitting || !markAtRiskForm.ready || markAtRiskForm.resultId) return;
    if (!canOperate) { setMarkAtRiskForm((current) => current ? { ...current, error: "当前账号没有采购订单操作权限。" } : current); return; }
    const reason = markAtRiskForm.reason.trim();
    const recommendedAction = markAtRiskForm.recommendedAction.trim();
    if (reason.length < 4) {
      setMarkAtRiskForm((current) => current ? { ...current, error: "风险原因至少需要 4 个字符。" } : current);
      return;
    }
    if (recommendedAction && recommendedAction.length < 4) {
      setMarkAtRiskForm((current) => current ? { ...current, error: "处置建议至少需要 4 个字符，或留空。" } : current);
      return;
    }
    setMarkAtRiskSubmitting(true);
    setMarkAtRiskForm((current) => current ? { ...current, error: null } : current);
    try {
      const result = await apiRequest<{ exception: Row }>("/api/procurement/execution/mark_at_risk", {
        method: "POST",
        headers: { "Idempotency-Key": markAtRiskForm.idempotencyKey },
        body: {
          aggregateId: markAtRiskForm.aggregateId,
          expectedVersion: markAtRiskForm.expectedVersion,
          riskSeverity: markAtRiskForm.riskSeverity,
          riskCategory: markAtRiskForm.riskCategory,
          reason,
          ...(recommendedAction ? { recommendedAction } : {}),
        },
        timeoutMs: 20_000,
      });
      const resultId = asText(result.exception?.id, "");
      if (!resultId) throw new Error("后端未返回人工风险异常，结果不明；请先刷新状态。");
      setMarkAtRiskForm((current) => current ? { ...current, resultId } : current);
      await loadWorkbench(true);
      await loadDetail(markAtRiskForm.aggregateId, true);
    } catch (cause) {
      setMarkAtRiskForm((current) => current ? { ...current, error: errorMessage(cause) } : current);
      if (cause instanceof ReadyworkApiError && cause.status === 409) {
        await loadWorkbench(true);
        await loadDetail(markAtRiskForm.aggregateId, true);
      }
    } finally {
      setMarkAtRiskSubmitting(false);
    }
  }, [canOperate, loadDetail, loadWorkbench, markAtRiskForm, markAtRiskSubmitting]);

  const submitEditPurchaseOrder = useCallback(async () => {
    if (!editForm || editSubmittingRef.current || editSubmitting) return;
    if (!canOperate) { setEditForm((current) => current ? { ...current, error: "当前账号没有采购订单操作权限。" } : current); return; }
    const reason = editForm.reason.trim();
    if (reason.length < 4) {
      setEditForm((current) => current ? { ...current, error: "修改原因至少需要 4 个字符，以便审计。" } : current);
      return;
    }
    const patch = buildEditPurchaseOrderPatch(editForm.baseline, editForm, { external: editForm.external });
    if (Object.keys(patch).length === 0) {
      setEditForm((current) => current ? { ...current, error: "没有可提交的实际变更。" } : current);
      return;
    }
    editSubmittingRef.current = true;
    setEditSubmitting(true);
    setEditForm((current) => current ? { ...current, error: null } : current);
    try {
      const result = await apiRequest<Row>("/api/procurement/execution/edit_po", {
        method: "POST", headers: { "Idempotency-Key": editForm.idempotencyKey },
        body: {
          aggregateId: editForm.aggregateId, expectedVersion: editForm.expectedVersion, reason,
          patch,
        }, timeoutMs: 20_000,
      });
      const amendment = result.amendment as Row | undefined;
      setEditForm(null);
      await loadWorkbench(true); await loadDetail(editForm.aggregateId, true);
      setFeedback({ tone: amendment ? "pending" : "success", text: amendment ? "Odoo 变更请求已排队，等待权威读回。" : "采购订单修改已保存。" });
    } catch (cause) {
      const serverVersion = cause instanceof ReadyworkApiError && typeof (cause.payload as Row | undefined)?.currentVersion === "number"
        ? (cause.payload as Row).currentVersion as number : null;
      setEditForm((current) => current ? { ...current, error: errorMessage(cause), serverVersion: serverVersion ?? current.serverVersion } : current);
      if (cause instanceof ReadyworkApiError && cause.status === 409) { await loadWorkbench(true); await loadDetail(editForm.aggregateId, true); }
    } finally { editSubmittingRef.current = false; setEditSubmitting(false); }
  }, [canOperate, editForm, editSubmitting, loadDetail, loadWorkbench]);

  const submitDuplicatePurchaseOrder = useCallback(async () => {
    if (!duplicateForm || duplicateSubmittingRef.current || duplicateSubmitting) return;
    if (!canOperate) { setDuplicateForm((current) => current ? { ...current, error: "当前账号没有采购订单操作权限。" } : current); return; }
    const newPurchaseOrderNumber = duplicateForm.newPurchaseOrderNumber.trim();
    const reason = duplicateForm.reason.trim();
    if (!newPurchaseOrderNumber) {
      setDuplicateForm((current) => current ? { ...current, error: "请输入唯一的新 PO 编号。" } : current);
      return;
    }
    if (!duplicateForm.newRequiredInHouseAt) {
      setDuplicateForm((current) => current ? { ...current, error: "请选择新采购订单的 RIHD。" } : current);
      return;
    }
    if (reason.length < 4) {
      setDuplicateForm((current) => current ? { ...current, error: "复制原因至少需要 4 个字符，以便审计。" } : current);
      return;
    }
    duplicateSubmittingRef.current = true;
    setDuplicateSubmitting(true);
    setDuplicateForm((current) => current ? { ...current, error: null } : current);
    try {
      const result = await apiRequest<Row>("/api/procurement/execution/duplicate_po", {
        method: "POST",
        headers: { "Idempotency-Key": duplicateForm.idempotencyKey },
        body: {
          aggregateId: duplicateForm.aggregateId,
          expectedVersion: duplicateForm.expectedVersion,
          purchaseOrderNumber: newPurchaseOrderNumber,
          requiredInHouseAt: duplicateForm.newRequiredInHouseAt,
          reason,
        },
        timeoutMs: 20_000,
      });
      const created = rows(result.createdDocuments).find((document) => document.sourceSystem === "readywork" && document.status === "draft");
      const createdId = asText(created?.id, "");
      if (!createdId) throw new Error("后端未返回新建采购订单草稿，结果不明；请先刷新后再决定是否重试。");
      setSearch("");
      setGroupFilter("all");
      setRiskFilter("all");
      const refreshed = await loadWorkbench(false, 30_000);
      const createdInWorkbench = refreshed?.documents?.purchaseOrders?.items?.some((document) => asText(document.id, "") === createdId) === true;
      if (!createdInWorkbench) {
        throw new Error(`采购订单草稿 ${newPurchaseOrderNumber} 已提交，但工作台尚未读回该记录。请保留当前请求编号并重试刷新；系统不会用同一幂等键重复创建。`);
      }
      setDuplicateForm(null);
      setDetail(null);
      setSelectedId(createdId);
      setTab("overview");
      setDetailVisible(true);
      setDetailOpen(!desktopDetailSurface);
      onPurchaseOrderNavigationChange?.(createdId, "overview");
      setFeedback({ tone: "success", purchaseOrderId: createdId, text: `采购订单草稿 ${newPurchaseOrderNumber} 已保存，已打开新采购订单。` });
    } catch (cause) {
      setDuplicateForm((current) => current ? { ...current, error: errorMessage(cause) } : current);
      if (cause instanceof ReadyworkApiError && cause.status === 409) {
        await loadWorkbench(true);
        await loadDetail(duplicateForm.aggregateId, true);
      }
    } finally {
      duplicateSubmittingRef.current = false;
      setDuplicateSubmitting(false);
    }
  }, [canOperate, desktopDetailSurface, duplicateForm, duplicateSubmitting, loadDetail, loadWorkbench, onPurchaseOrderNavigationChange]);

  const submitCancelPurchaseOrder = useCallback(async () => {
    if (!cancelForm || cancelSubmittingRef.current || cancelSubmitting) return;
    if (!canOperate || !canApprove) { setCancelForm((current) => current ? { ...current, error: "当前账号没有取消采购订单所需的操作与审批权限。" } : current); return; }
    const reason = cancelForm.reason.trim();
    if (reason.length < 4) {
      setCancelForm((current) => current ? { ...current, error: "取消原因至少需要 4 个字符，以便审计。" } : current);
      return;
    }
    if (cancelForm.blockers.length > 0 && cancelForm.result === null) {
      setCancelForm((current) => current ? { ...current, error: "当前履约事实已阻断取消；请先处理下方阻断项。" } : current);
      return;
    }
    cancelSubmittingRef.current = true;
    setCancelSubmitting(true);
    setCancelForm((current) => current ? { ...current, error: null } : current);
    try {
      const result = await apiRequest<CancelPurchaseOrderResult>("/api/procurement/execution/cancel_po", {
        method: "POST",
        headers: { "Idempotency-Key": cancelForm.idempotencyKey },
        body: {
          aggregateId: cancelForm.aggregateId,
          expectedVersion: cancelForm.expectedVersion,
          reason,
        },
        timeoutMs: 20_000,
      });
      if (!result.requestId || !["cancelled", "pending_external", "failed", "unknown"].includes(result.status)) {
        throw new Error("取消接口未返回可验证的状态，请保留当前请求编号并对账。");
      }
      const nextForm: CancelPurchaseOrderForm = { ...cancelForm, reason, result, error: null };
      if (result.status === "cancelled") {
        unresolvedCancellationsRef.current.delete(cancelForm.aggregateId);
        setCancelDialogOpen(false);
        setCancelForm(null);
        await Promise.all([loadWorkbench(true), loadDetail(cancelForm.aggregateId, true)]);
        setFeedback({ tone: "success", text: `采购订单 ${cancelForm.purchaseOrderNumber} 已取消；行项目、文档和历史均已保留。` });
      } else {
        unresolvedCancellationsRef.current.set(cancelForm.aggregateId, nextForm);
        setCancelForm(nextForm);
        await Promise.all([loadWorkbench(true), loadDetail(cancelForm.aggregateId, true)]);
        setFeedback({
          tone: result.status === "pending_external" ? "pending" : "error",
          text: result.status === "pending_external"
            ? "Odoo 取消请求已排队，等待权威读回。"
            : result.status === "unknown"
              ? "外部结果尚不明确，请使用同一请求编号核对状态。"
              : "Odoo 已明确拒绝取消，当前采购订单未标记为已取消。",
        });
      }
    } catch (cause) {
      if (cause instanceof ReadyworkApiError && (cause.status === 0 || cause.status === 408)) {
        const unknownResult: CancelPurchaseOrderResult = {
          requestId: cancelForm.result?.requestId ?? cancelForm.idempotencyKey,
          status: "unknown",
          purchaseOrderVersion: cancelForm.result?.purchaseOrderVersion ?? cancelForm.expectedVersion,
          outboxId: cancelForm.result?.outboxId ?? null,
        };
        const nextForm = { ...cancelForm, reason, result: unknownResult, error: "网络结果无法确认；请使用同一请求编号对账，不要新建取消请求。" };
        unresolvedCancellationsRef.current.set(cancelForm.aggregateId, nextForm);
        setCancelForm(nextForm);
      } else {
        setCancelForm((current) => {
          if (!current) return current;
          const next = { ...current, error: errorMessage(cause) };
          unresolvedCancellationsRef.current.set(current.aggregateId, next);
          return next;
        });
        if (cause instanceof ReadyworkApiError && cause.status === 409) {
          await Promise.all([loadWorkbench(true), loadDetail(cancelForm.aggregateId, true)]);
        }
      }
    } finally {
      cancelSubmittingRef.current = false;
      setCancelSubmitting(false);
    }
  }, [canApprove, canOperate, cancelForm, cancelSubmitting, loadDetail, loadWorkbench]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // These modal primitives own Escape and prevent dismissal while saving.
      if (duplicateForm || confirming) return;
      if (cancelDialogOpen && !cancelSubmitting) setCancelDialogOpen(false);
      else if (editForm && !editSubmitting) setEditForm(null);
      else if (detailOpen) setDetailOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [cancelDialogOpen, cancelSubmitting, confirming, detailOpen, duplicateForm, duplicateSubmitting, editForm, editSubmitting, submitting]);

  useEffect(() => {
    if (!cancelDialogOpen || !cancelForm?.result) return;
    const animationFrame = window.requestAnimationFrame(() => {
      cancelStatusRef.current?.scrollIntoView?.({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [cancelDialogOpen, cancelForm?.result]);

  const actions = useMemo<ActionPlan[]>(() => {
    if (!po || !poVersion) return [];
    const make = (input: Omit<ActionPlan, "idempotencyKey">): ActionPlan => ({
      ...input,
      idempotencyKey: input.runtime ? `runtime:${input.id}` : `web-po:${input.id}:${asText(input.body.aggregateId, "aggregate")}:v${asNumber(input.body.expectedVersion) ?? "na"}`,
    });
    if (pendingExecutionApproval?.id) return canApprove ? [
      make({ id: "approve-confirmation", label: pendingShortfall?.hasShortfall ? poDetailShortfallApprovalLabel(pendingShortfall) : "批准差异并继续", description: pendingShortfall?.hasShortfall ? "接受供应商短交，并永久关闭未确认的剩余数量。" : "接受供应商确认的数量、价格或交期差异。", sideEffects: ["绑定当前审批人身份", "更新确认单和 PO 状态", ...(pendingShortfall?.hasShortfall ? ["逐行关闭未确认的剩余数量"] : []), "重新计算行级累计数量", "智能体从审批点继续运行"], tone: "primary", endpoint: "/api/procurement/execution/decide_confirmation", body: { aggregateId: pendingExecutionApproval.id, expectedVersion: poVersion, decision: "approved", ...(pendingShortfall?.hasShortfall ? { shortfallDisposition: "cancel_remainder" } : {}) }, reasonEditable: true, requiresReason: pendingShortfall?.hasShortfall, shortfallLines: pendingShortfall?.hasShortfall ? pendingShortfall.lines : undefined, expectsOutbox: false, successMessage: pendingShortfall?.hasShortfall ? "短交已批准，未确认的剩余数量已关闭。" : "供应商确认差异已批准，PO 已从审批点继续。" }),
      make({ id: "reject-confirmation", label: "拒绝差异", description: "不接受当前供应商确认，保留原因以便后续沟通。", sideEffects: ["将审批与确认单标记为已拒绝", "将 PO 转入供应商拒绝状态", "写入审计时间线"], tone: "danger", endpoint: "/api/procurement/execution/decide_confirmation", body: { aggregateId: pendingExecutionApproval.id, expectedVersion: poVersion, decision: "rejected" }, reasonEditable: true, expectsOutbox: false, successMessage: "供应商确认差异已拒绝，审计记录已保存。" }),
    ] : [];
    if (pendingRuntimeApproval) return canApprove && pendingRuntimeApproval.id && relatedTask?.id ? [
      make({ id: "approve-runtime", label: "批准并让员工继续", description: asText(pendingRuntimeApproval.message, "批准当前运行时审批。"), preserveDescription: hasDataText(pendingRuntimeApproval.message), sideEffects: ["绑定当前审批人", "从当前工作流检查点续跑", "保留所有后续工具调用记录"], tone: "primary", endpoint: `/api/tasks/${encodeURIComponent(asText(relatedTask.id))}/approve`, body: { approvalId: pendingRuntimeApproval.id }, runtime: true }),
      make({ id: "reject-runtime", label: "驳回当前建议", description: "不允许智能体执行当前建议。", sideEffects: ["将审批标记为已驳回", "保留人工决策身份与时间", "不会触发未批准的外部副作用"], tone: "danger", endpoint: `/api/tasks/${encodeURIComponent(asText(relatedTask.id))}/reject`, body: { approvalId: pendingRuntimeApproval.id }, runtime: true }),
    ] : [];
    if (!canOperate) return [];
    if (po.status === "draft") {
      const needsOdooDraft = po.sourceSystem === "readywork" && selectedSupplier?.sourceSystem === "odoo" && !po.odooReference;
      if (needsOdooDraft) return hasUnfinishedOdooCreate ? [] : [make({
        id: "sync-odoo-draft", label: "创建 Odoo 采购订单草稿", description: "将当前已冻结的 PO 版本幂等创建为真实 Odoo Draft；收到 Odoo 单号前不会标记成功。",
        sideEffects: ["冻结 PO 版本、Odoo 供应商映射和行项目", "创建持久化 ERP Outbox", "按唯一 correlation key 查重并创建 Odoo draft", "回读真实 Odoo 单号并写入审计时间线"], tone: "primary", endpoint: "/api/procurement/execution/create_odoo_po_draft", body: { aggregateId: po.id, expectedVersion: poVersion, connectorId: "erp" },
        outboxLabels: { pending: "已进入 Odoo 创建队列", blocked: "Odoo 连接器未就绪，未创建草稿", failed: "Odoo 草稿创建失败", dispatched: "Odoo 草稿已创建并回读真实单号", unknown: "Odoo 创建结果不明；请先刷新对账，不要重复创建。" },
      })];
      const sendAvailability = poSendActionAvailability(activeDetail?.actionReadiness?.send_po);
      return hasUnfinishedSend ? [] : [make({ id: "send-po", label: "发送 PO 给供应商", description: "经过真实邮箱连接器发送；连接器回执成功前 PO 仍保持草稿。", sideEffects: ["检查 PO 版本与发送权限", "创建持久化邮件 Outbox", "连接器成功后再将 PO 改为已发送", "创建供应商确认等待事项"], tone: "primary", endpoint: "/api/procurement/execution/send_po", body: { aggregateId: po.id, expectedVersion: poVersion, connectorId: "email" }, ready: sendAvailability.ready, readinessMessage: sendAvailability.message, readinessTarget: sendAvailability.target })];
    }
    const poLines = activeDetail?.linesByDocument?.[asText(po.id, "")] ?? rows(po.lines);
    const projections = new Map((activeDetail?.quantityProjections ?? []).map((projection) => [asText(projection.poLineId, ""), projection]));
    const inboundConfirmationEvidence = sortPoDetailCommunications(activeDetail?.communications ?? [])
      .filter((communication) => communication.direction === "inbound"
        && communication.businessObjectType === "purchase_order"
        && communication.businessObjectId === po.id
        && communication.status === "received")
      .map((communication) => ({
        id: asText(communication.id),
        subject: asText(communication.subject, "无主题供应商回复"),
        from: asText(communication.from, "发件人未记录"),
        receivedAt: asText(communication.receivedAt, asText(communication.occurredAt, "")),
        body: asText(communication.body, ""),
        messageId: asText(communication.messageId, "") || undefined,
      }))
      .filter((communication) => communication.id);
    const confirmationEvidenceLines = poLines.map((line) => ({
      poLineId: asText(line.id),
      label: asText(line.description, asText(line.itemId, "未记录物料")),
      uom: asText(line.uom, ""),
      orderedQty: asNumber(line.orderedQty) ?? 0,
      poUnitPrice: asNumber(line.unitPrice) ?? null,
      currency: asText(line.currency, asText(po.currency, "")),
      requestedAt: asText(line.requestedAt, "") || null,
    })).filter((line) => line.poLineId && line.orderedQty > 0);
    const latestConfirmationReply = inboundConfirmationEvidence[0];
    const latestConfirmationReplyAnalysis = latestConfirmationReply && confirmationEvidenceLines.length
      ? analyzeSupplierReply({
        communication: latestConfirmationReply,
        earlierCommunications: inboundConfirmationEvidence.slice(1),
        poLines: confirmationEvidenceLines.map((line) => ({
          poLineId: line.poLineId,
          orderedQty: line.orderedQty,
          poUnitPrice: line.poUnitPrice,
          requestedAt: line.requestedAt,
          description: line.label,
          uom: line.uom,
        })),
      })
      : null;
    const confirmationClarification = buildPoConfirmationClarificationPlan(latestConfirmationReplyAnalysis);
    const followupAvailability = poFollowupActionAvailability(activeDetail?.actionReadiness?.queue_followup);
    const evidenceLines = poLines.map((line): DeliveryEvidenceLine => {
      const projection = projections.get(asText(line.id, ""));
      const orderedQty = asNumber(projection?.orderedQty) ?? asNumber(line.orderedQty) ?? 0;
      const confirmedQty = asNumber(projection?.confirmedQty) || orderedQty;
      const shippedQty = asNumber(projection?.shippedQty) ?? 0;
      const receivedQty = asNumber(projection?.receivedQty) ?? 0;
      const canShip = Math.max(0, Math.min(orderedQty, confirmedQty) - shippedQty);
      const canReceive = Math.max(0, shippedQty - receivedQty);
      return { poLineId: asText(line.id), label: asText(line.description, asText(line.itemId, "未记录物料")), uom: asText(line.uom, ""), orderedQty, shippedQty, receivedQty, maxQuantity: ["shipped", "partially_received"].includes(String(po.status ?? "")) ? canReceive : canShip };
    });
    const productionLines = poLines.map((line) => {
      const projection = projections.get(asText(line.id, ""));
      const orderedQty = asNumber(projection?.orderedQty) ?? asNumber(line.orderedQty) ?? 0;
      const cancelledQty = asNumber(projection?.cancelledQty) ?? 0;
      return { poLineId: asText(line.id), label: asText(line.description, asText(line.itemId, "未记录物料")), uom: asText(line.uom, ""), effectiveQty: Math.max(0, orderedQty - cancelledQty) };
    }).filter((line) => line.effectiveQty > 0);
    const shipmentLines = evidenceLines.map((line) => ({ ...line, maxQuantity: Math.max(0, line.orderedQty - line.shippedQty) })).filter((line) => line.maxQuantity > 0);
    const receiptLines = evidenceLines.map((line) => ({ ...line, maxQuantity: Math.max(0, line.shippedQty - line.receivedQty) })).filter((line) => line.maxQuantity > 0);
    const result: ActionPlan[] = [];
    if (currentExecutionStage === "supplier_commitment"
      && !(activeDetail?.confirmations ?? []).some((confirmation) => confirmation.status !== "rejected")
      && inboundConfirmationEvidence.length
      && confirmationEvidenceLines.length) result.push(make({
        id: "record-confirmation",
        label: "从供应商回复登记确认",
        description: "选择一封已关联当前 PO 的真实入站回复，逐行核对数量、价格和承诺交期；任何差异只会创建人工审批，不会自动接受。",
        sideEffects: ["校验回复属于当前租户、PO 与供应商", "保存逐行数量、单价和承诺交期", "差异进入人工定标审批并保留原始邮件证据", "审批完成后智能体从供应商承诺阶段继续"],
        tone: "primary", endpoint: "/api/procurement/execution/record_confirmation",
        body: { aggregateId: po.id, expectedVersion: poVersion }, expectsOutbox: false,
        successMessage: "供应商确认事实已持久化；如有差异，已进入待审批状态。",
        confirmationEvidenceForm: { communications: inboundConfirmationEvidence, lines: confirmationEvidenceLines },
      }));
    if (canApprove && currentExecutionStage === "fulfilment_production" && productionLines.length) result.push(make({
      id: "record-production-progress", label: "核验生产 / 备货进度", description: "依据供应商邮件、附件或会议纪要登记行级完成度与预计可发运时间；不会冒充供应商连接器事实。",
      sideEffects: ["校验进度证据编号、原始依据和核验原因", "保存每条 PO 行的状态、完成度、完成数量与预计可发运时间", "写入不可变 Production Progress 和 Fulfilment 阶段事件", "延期或受阻进入风险与通知；全部行待发运后完成 Fulfilment 阶段"], tone: "primary",
      endpoint: "/api/procurement/execution/record_production_progress", body: { aggregateId: po.id, expectedVersion: poVersion }, expectsOutbox: false,
      successMessage: "生产 / 备货进度已持久化，阶段、风险和审计上下文已更新。", productionProgressForm: { lines: productionLines },
    }));
    if (canApprove && ["fulfilment_production", "dispatch_transit"].includes(currentExecutionStage) && shipmentLines.length) result.push(make({
      id: "record-shipment", label: "核验并记录发运 / ASN", description: "由有审批权限的人核对原始证据后登记；系统不会把它冒充成供应商连接器事实。",
      sideEffects: ["校验发运单号、原始证据和每行剩余可发数量", "保存核验人、原因与证据编号", "持久化人工核验 Shipment 与发运行", "推进发运 / 在途阶段并写入不可变事件"], tone: "primary",
      endpoint: "/api/procurement/execution/record_shipment", body: { aggregateId: po.id, expectedVersion: poVersion }, expectsOutbox: false,
      successMessage: "发运事实已保存，行级累计数量和阶段时间线已更新。", evidenceForm: { kind: "shipment", lines: shipmentLines },
    }));
    const shipmentOptions = (activeDetail?.shipments ?? []).map((shipment) => ({ id: asText(shipment.id), reference: asText(shipment.externalId, asText(shipment.trackingNumber, compactId(shipment.id))) }));
    if (canApprove && ["dispatch_transit", "delivery_grn"].includes(currentExecutionStage) && shipmentOptions.length) result.push(make({
      id: "record-transport-event", label: "核验并记录运输节点", description: "登记承运商轨迹、ETA 或清关事实；承运商“已送达”不会替代仓库 / ERP GRN。",
      sideEffects: ["校验 Shipment、节点类型、实际发生时间和证据编号", "保存位置、承运商参考号、ETA 与核验身份", "写入不可变 Transport Event 和 Dispatch / Transit 阶段事件", "运输异常或清关受阻进入风险计算；不会自动生成 GRN"], tone: "primary",
      endpoint: "/api/procurement/execution/record_transport_event", body: { aggregateId: po.id, expectedVersion: poVersion }, expectsOutbox: false,
      successMessage: "运输节点已持久化，路线、风险和审计上下文已更新。", transportEventForm: { shipments: shipmentOptions, route: asText(selected?.po.route, "unclassified") },
    }));
    if (canApprove && ["dispatch_transit", "delivery_grn"].includes(currentExecutionStage) && receiptLines.length) result.push(make({
      id: "record-receipt", label: "核验并记录到货 / GRN", description: "由有审批权限的人核对仓库或 ERP 原始证据后登记；最终收货会完成 Delivery / GRN 阶段。",
      sideEffects: ["校验 GRN 号、原始证据和每行已发未收数量", "保存核验人、原因与证据编号", "持久化人工核验 Receipt 与收货行", "累计部分到货或完成最终 GRN 并写入不可变事件"], tone: "primary",
      endpoint: "/api/procurement/execution/record_receipt", body: { aggregateId: po.id, expectedVersion: poVersion }, expectsOutbox: false,
      successMessage: "收货事实已保存，GRN 累计和阶段时间线已更新。", evidenceForm: { kind: "receipt", lines: receiptLines, shipments: (activeDetail?.shipments ?? []).map((shipment) => ({ id: asText(shipment.id), reference: asText(shipment.externalId, asText(shipment.trackingNumber, compactId(shipment.id))) })) },
    }));
    if (["supplier_commitment", "fulfilment_production", "dispatch_transit", "delivery_grn"].includes(currentExecutionStage)) {
      const deliveryFollowup = ["dispatch_transit", "delivery_grn"].includes(currentExecutionStage);
      const supplierCommitmentFollowup = currentExecutionStage === "supplier_commitment";
      result.push(
        make({
          id: "followup-confirm",
          label: deliveryFollowup ? "跟进到货进度" : supplierCommitmentFollowup ? confirmationClarification.label : "跟进生产进度",
          description: deliveryFollowup ? "询问在途状态、预计到货时间和剩余批次。" : supplierCommitmentFollowup ? confirmationClarification.description : "请供应商更新备货、生产完成度与预计发运日。",
          sideEffects: [
            ...(supplierCommitmentFollowup && confirmationClarification.targeted ? ["绑定最新真实入站回复和缺失字段"] : []),
            "生成带 PO 上下文的持久化邮件草稿",
            "转到沟通草稿由人编辑 / 批准",
            "未批准前不进入 Outbox",
          ],
          tone: "primary",
          endpoint: "/api/procurement/execution/queue_followup",
          body: {
            aggregateId: po.id,
            expectedVersion: poVersion,
            connectorId: "email",
            reason: deliveryFollowup ? "请更新在途状态、预计到货时间和剩余批次计划" : supplierCommitmentFollowup ? confirmationClarification.reason : "请更新当前备货、生产完成度与预计发运日",
            ...(supplierCommitmentFollowup && confirmationClarification.targeted && latestConfirmationReply ? {
              supplierReference: latestConfirmationReply.id,
              confirmationMissingFields: confirmationClarification.missingFields,
            } : {}),
          },
          ready: followupAvailability.ready,
          readinessMessage: followupAvailability.message,
          readinessTarget: followupAvailability.target,
          expectsOutbox: false,
          successMessage: "跟进草稿已持久化，请在沟通草稿中编辑并批准发送。",
        }),
        make({ id: "partial-delivery", label: "要求分批交付", description: "请供应商提供每批数量与发货日期。", sideEffects: ["生成分批交付沟通草稿", "人工编辑 / 批准后才入 Outbox", "回复后由行级累计数量继续处理"], tone: "warning", endpoint: "/api/procurement/execution/queue_followup", body: { aggregateId: po.id, expectedVersion: poVersion, connectorId: "email", reason: "请提供可行的分批交付方案，明确每批数量和发货日期" }, ready: followupAvailability.ready, readinessMessage: followupAvailability.message, readinessTarget: followupAvailability.target, expectsOutbox: false, successMessage: "分批交付草稿已持久化，尚未发送。" }),
        make({ id: "expedite", label: "要求加急", description: "为供应商生成加急沟通草稿。", sideEffects: ["生成加急邮件草稿", "人工编辑 / 批准后才入 Outbox", "新承诺到达后重新执行差异判断"], tone: "warning", endpoint: "/api/procurement/execution/queue_followup", body: { aggregateId: po.id, expectedVersion: poVersion, connectorId: "email", reason: "请加急当前采购订单，并回复最早可行发货日期" }, ready: followupAvailability.ready, readinessMessage: followupAvailability.message, readinessTarget: followupAvailability.target, expectsOutbox: false, successMessage: "加急草稿已持久化，尚未发送。" }),
        make({ id: "keep-date", label: "不接受新交期", description: "要求供应商维持 PO 原定承诺。", sideEffects: ["生成维持原交期的沟通草稿", "保留当前 PO 事实不变", "人工批准后才入 Outbox"], tone: "neutral", endpoint: "/api/procurement/execution/queue_followup", body: { aggregateId: po.id, expectedVersion: poVersion, connectorId: "email", reason: "当前不接受新交期，请维持采购订单原定交付计划并确认" }, ready: followupAvailability.ready, readinessMessage: followupAvailability.message, readinessTarget: followupAvailability.target, expectsOutbox: false, successMessage: "维持原交期草稿已持久化，尚未发送。" }),
      );
    }
    return result;
  }, [activeDetail, canApprove, canOperate, currentExecutionStage, hasUnfinishedOdooCreate, hasUnfinishedSend, pendingExecutionApproval, pendingShortfall, pendingRuntimeApproval, po, poVersion, relatedTask, selected?.po.route, selectedSupplier?.sourceSystem]);

  const refreshAll = useCallback(async () => {
    await Promise.all([loadWorkbench(true), selectedId ? loadDetail(selectedId, true) : Promise.resolve()]);
  }, [loadDetail, loadWorkbench, selectedId]);

  const submitAction = useCallback(async () => {
    if (!confirming || submitting) return;
    // The dialog holds its reviewed payload, not a grant of authority. A live
    // refresh may revoke permission, block readiness, or replace this action.
    if (!actions.some((action) => action.id === confirming.id && action.endpoint === confirming.endpoint && action.ready !== false)) {
      setFeedback({ tone: "error", text: "当前操作权限或订单状态已变化，请关闭确认窗口并重新核对。" });
      return;
    }
    let body: Row = { ...confirming.body, ...(confirming.reasonEditable && reason.trim() ? { reason: reason.trim() } : {}) };
    if (confirming.requiresReason && !reason.trim()) {
      setFeedback({ tone: "error", text: "短交审批必须填写关闭剩余量的原因。" });
      return;
    }
    if (confirming.confirmationEvidenceForm) {
      if (!confirmationCommunicationId) { setFeedback({ tone: "error", text: "请选择一封当前 PO 的真实供应商入站回复。" }); return; }
      const lines = confirming.confirmationEvidenceForm.lines.map((line) => ({
        line,
        quantity: Number(confirmationQuantities[line.poLineId]),
        unitPrice: Number(confirmationUnitPrices[line.poLineId]),
        promisedAt: confirmationPromisedDates[line.poLineId] ?? "",
      }));
      if (lines.some(({ quantity }) => !Number.isFinite(quantity) || quantity <= 0)) {
        setFeedback({ tone: "error", text: "每条 PO 行都必须填写大于 0 的供应商确认数量。" }); return;
      }
      if (lines.some(({ unitPrice }) => !Number.isFinite(unitPrice) || unitPrice < 0)) {
        setFeedback({ tone: "error", text: "每条 PO 行都必须明确填写非负的供应商确认单价。" }); return;
      }
      if (lines.some(({ promisedAt }) => !promisedAt || !Number.isFinite(Date.parse(promisedAt)))) {
        setFeedback({ tone: "error", text: "每条 PO 行都必须填写有效的供应商承诺交期。" }); return;
      }
      body = {
        ...body,
        supplierReference: confirmationCommunicationId,
        lines: lines.map(({ line, quantity, unitPrice, promisedAt }) => ({
          poLineId: line.poLineId, quantity, unitPrice, promisedAt,
        })),
      };
    }
    if (confirming.evidenceForm) {
      if (!evidenceReference.trim()) { setFeedback({ tone: "error", text: confirming.evidenceForm.kind === "shipment" ? "请填写真实 ASN / 发运单号。" : "请填写真实 GRN / 收货单号。" }); return; }
      if (!verificationReference.trim()) { setFeedback({ tone: "error", text: "请填写可追溯的人工核验依据。" }); return; }
      if (!reason.trim()) { setFeedback({ tone: "error", text: "请填写人工核验原因。" }); return; }
      if (confirming.evidenceForm.kind === "receipt" && !warehouseId.trim()) { setFeedback({ tone: "error", text: "请填写真实仓库或 ERP 仓库标识。" }); return; }
      const estimatedArrivalIso = estimatedArrivalAt ? new Date(estimatedArrivalAt).toISOString() : undefined;
      const lines = confirming.evidenceForm.lines.map((line) => ({ line, quantity: Number(evidenceQuantities[line.poLineId] ?? 0) }))
        .filter((entry) => Number.isFinite(entry.quantity) && entry.quantity > 0);
      if (!lines.length) { setFeedback({ tone: "error", text: "请至少为一条 PO 行填写本次数量。" }); return; }
      if (lines.some((entry) => entry.quantity > entry.line.maxQuantity)) { setFeedback({ tone: "error", text: "本次数量不能超过该行当前可发或已发未收数量。" }); return; }
      body = {
        ...body, supplierReference: evidenceReference.trim(), evidenceReference: verificationReference.trim(), reason: reason.trim(),
        lines: lines.map((entry) => ({ poLineId: entry.line.poLineId, quantity: entry.quantity })),
        ...(confirming.evidenceForm.kind === "shipment" && carrier.trim() ? { carrier: carrier.trim() } : {}),
        ...(confirming.evidenceForm.kind === "shipment" && trackingNumber.trim() ? { trackingNumber: trackingNumber.trim() } : {}),
        ...(confirming.evidenceForm.kind === "shipment" && estimatedArrivalIso ? { estimatedArrivalAt: estimatedArrivalIso } : {}),
        ...(confirming.evidenceForm.kind === "receipt" ? { warehouseId: warehouseId.trim() } : {}),
        ...(confirming.evidenceForm.kind === "receipt" && shipmentId ? { shipmentId } : {}),
      };
    }
    if (confirming.productionProgressForm) {
      if (!productionProgressReference.trim()) { setFeedback({ tone: "error", text: "请填写生产进度证据编号。" }); return; }
      if (!verificationReference.trim()) { setFeedback({ tone: "error", text: "请填写可追溯的人工核验依据。" }); return; }
      if (!reason.trim()) { setFeedback({ tone: "error", text: "请填写人工核验原因。" }); return; }
      if (["delayed", "blocked"].includes(productionProgressStatus) && !productionNote.trim()) { setFeedback({ tone: "error", text: "延期或受阻必须填写供应商说明。" }); return; }
      const selectedLines = confirming.productionProgressForm.lines.filter((line) =>
        productionQuantities[line.poLineId] !== undefined || productionPercentages[line.poLineId] !== undefined);
      if (!selectedLines.length) { setFeedback({ tone: "error", text: "请至少填写一条 PO 行的完成数量和完成度。" }); return; }
      const normalized = selectedLines.map((line) => ({ line, quantity: Number(productionQuantities[line.poLineId]), percentage: Number(productionPercentages[line.poLineId]) }));
      if (normalized.some(({ quantity, percentage }) => !Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(percentage) || percentage < 0 || percentage > 100)) {
        setFeedback({ tone: "error", text: "完成数量必须为非负数，完成度必须在 0–100% 之间。" }); return;
      }
      if (normalized.some(({ line, quantity }) => quantity > line.effectiveQty)) { setFeedback({ tone: "error", text: "完成数量不能超过该行有效订购数量。" }); return; }
      if (productionProgressStatus === "ready_to_ship" && normalized.some(({ line, quantity, percentage }) => percentage !== 100 || quantity < line.effectiveQty)) {
        setFeedback({ tone: "error", text: "待发运状态要求完成度为 100%，且完成数量覆盖该行有效订购量。" }); return;
      }
      const readyIso = productionExpectedReadyAt ? new Date(productionExpectedReadyAt).toISOString() : undefined;
      body = {
        ...body, supplierReference: productionProgressReference.trim(), evidenceReference: verificationReference.trim(), reason: reason.trim(),
        lines: normalized.map(({ line, quantity, percentage }) => ({ poLineId: line.poLineId, quantity, completionPercent: percentage,
          progressStatus: productionProgressStatus, ...(readyIso ? { expectedReadyAt: readyIso } : {}), ...(productionNote.trim() ? { note: productionNote.trim() } : {}) })),
      };
    }
    if (confirming.transportEventForm) {
      if (!shipmentId) { setFeedback({ tone: "error", text: "请选择真实 Shipment。" }); return; }
      if (!transportEventReference.trim()) { setFeedback({ tone: "error", text: "请填写运输节点证据编号。" }); return; }
      if (!transportEventOccurredAt) { setFeedback({ tone: "error", text: "请填写运输节点实际发生时间。" }); return; }
      if (!verificationReference.trim()) { setFeedback({ tone: "error", text: "请填写可追溯的人工核验依据。" }); return; }
      if (!reason.trim()) { setFeedback({ tone: "error", text: "请填写人工核验原因。" }); return; }
      const eventOccurredIso = new Date(transportEventOccurredAt).toISOString();
      const estimatedArrivalIso = estimatedArrivalAt ? new Date(estimatedArrivalAt).toISOString() : undefined;
      body = {
        ...body, shipmentId, eventCode: transportEventCode, eventReference: transportEventReference.trim(),
        eventOccurredAt: eventOccurredIso, evidenceReference: verificationReference.trim(), reason: reason.trim(),
        ...(transportLocation.trim() ? { location: transportLocation.trim() } : {}),
        ...(carrierReference.trim() ? { carrierReference: carrierReference.trim() } : {}),
        ...(estimatedArrivalIso ? { estimatedArrivalAt: estimatedArrivalIso } : {}),
      };
    }
    setSubmitting(true);
    setFeedback(null);
    try {
      const result = await apiRequest<Row>(confirming.endpoint, {
        method: "POST",
        headers: confirming.runtime ? undefined : { "Idempotency-Key": confirming.idempotencyKey },
        body,
        timeoutMs: 20_000,
      });
      const outbox = result.outbox && typeof result.outbox === "object" && !Array.isArray(result.outbox) ? result.outbox as Row : undefined;
      const internalSuccess = confirming.expectsOutbox === false && Boolean(result.aggregate);
      const outboxLabels = confirming.outboxLabels ?? { pending: "已进入发送队列", blocked: "连接器未就绪，未发送", failed: "发送失败", dispatched: "已送达连接器", unknown: "未收到发送回执，结果不明；请先刷新状态。" };
      setFeedback(confirming.runtime ? { tone: "success", text: "后端已确认操作完成，最新业务状态已读取。" }
        : confirming.expectsOutbox === false ? { tone: internalSuccess ? "success" : "error", text: internalSuccess ? confirming.successMessage ?? "业务事实已持久化。" : "后端未返回更新后的业务对象，结果不明；请先刷新状态。" }
          : {
            tone: outbox?.status === "blocked" || outbox?.status === "failed" || !outbox ? "error" : outbox?.status === "pending" || outbox?.status === "processing" ? "pending" : "success",
            text: outbox?.status === "pending" || outbox?.status === "processing" ? outboxLabels.pending : outbox?.status === "blocked" ? outboxLabels.blocked : outbox?.status === "failed" ? outboxLabels.failed : outbox?.status === "dispatched" ? outboxLabels.dispatched : outboxLabels.unknown,
          });
      setConfirming(null);
      setReason("");
      await refreshAll();
    } catch (cause) {
      setFeedback({ tone: "error", text: errorMessage(cause) });
      if (cause instanceof ReadyworkApiError && cause.status === 409) await refreshAll();
    } finally { setSubmitting(false); }
  }, [actions, carrier, carrierReference, confirmationCommunicationId, confirmationPromisedDates, confirmationQuantities, confirmationUnitPrices, confirming, estimatedArrivalAt, evidenceQuantities, evidenceReference, productionExpectedReadyAt, productionNote, productionPercentages, productionProgressReference, productionProgressStatus, productionQuantities, reason, refreshAll, shipmentId, submitting, trackingNumber, transportEventCode, transportEventOccurredAt, transportEventReference, transportLocation, verificationReference, warehouseId]);

  const grouped = useMemo(() => Object.fromEntries((Object.keys(groupMeta) as QueueGroup[]).map((group) => [group, filteredQueue.filter((item) => item.group === group)])) as Record<QueueGroup, QueueItem[]>, [filteredQueue]);
  // These tabs filter this PO queue, so their counts must be derived from the
  // exact same queue classification. The global operations aggregate also
  // includes runtime tasks and therefore cannot truthfully label PO rows.
  const queueCounts = useMemo(() => Object.fromEntries((Object.keys(groupMeta) as QueueGroup[])
    .map((group) => [group, queue.filter((item) => item.group === group).length])) as Record<QueueGroup, number>, [queue]);
  const filterTabs: Array<{ id: QueueGroup | "all"; label: string; count: number | undefined }> = [
    { id: "all", label: "全部", count: queue.length },
    { id: "running", label: "正在执行", count: queueCounts.running },
    { id: "waiting_external", label: "等待外部", count: queueCounts.waiting_external },
    { id: "needs_action", label: "待我处理", count: queueCounts.needs_action },
    { id: "exception", label: "异常", count: queueCounts.exception },
    { id: "completed", label: "已完成", count: queueCounts.completed },
  ];
  const visibleGroups = (groupFilter === "all" ? Object.keys(groupMeta) as QueueGroup[] : [groupFilter]).filter((group) => grouped[group].length > 0);

  const selectQueueItem = (item: QueueItem, trigger?: HTMLElement) => {
    if (selectedId !== item.po.id) setDetail(null);
    const target = poDetailNavigationForPurchaseOrderSelection(asText(item.po.id));
    if (trigger) detailReturnFocusRef.current = trigger;
    setNavigationNotice(null);
    setSelectedId(target.purchaseOrderId);
    setTab(target.tab);
    setDetailOpen(!desktopDetailSurface);
    setDetailVisible(true);
    onPurchaseOrderNavigationChange?.(target.purchaseOrderId, target.tab);
  };

  const selectedQueueIndex = selectedId ? queue.findIndex((item) => item.po.id === selectedId) : -1;
  const previousPurchaseOrder = selectedQueueIndex > 0 ? queue[selectedQueueIndex - 1] : undefined;
  const nextPurchaseOrder = selectedQueueIndex >= 0 && selectedQueueIndex < queue.length - 1 ? queue[selectedQueueIndex + 1] : undefined;
  const navigateToAdjacentPurchaseOrder = (item: QueueItem | undefined) => {
    if (!item) return;
    const target = poDetailNavigationForPurchaseOrderSelection(asText(item.po.id));
    setNavigationNotice(null);
    setDetail(null);
    setSelectedId(target.purchaseOrderId);
    setTab(target.tab);
    setDetailVisible(true);
    onPurchaseOrderNavigationChange?.(target.purchaseOrderId, target.tab);
  };

  const beginAction = (plan: ActionPlan) => {
    confirmReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirming(plan);
    setReason("");
    setFeedback(null);
    setEvidenceReference("");
    setVerificationReference("");
    setCarrier("");
    setTrackingNumber("");
    setEstimatedArrivalAt("");
    setTransportEventCode("picked_up");
    const now = new Date();
    setTransportEventOccurredAt(new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    setTransportEventReference("");
    setTransportLocation("");
    setCarrierReference("");
    setWarehouseId(plan.evidenceForm?.kind === "receipt" ? asText(activeDetail?.receipts?.at(-1)?.warehouseId, "") : "");
    setShipmentId(plan.evidenceForm?.kind === "receipt" ? asText(plan.evidenceForm.shipments?.at(-1)?.id, "")
      : plan.transportEventForm ? asText(plan.transportEventForm.shipments.at(-1)?.id, "") : "");
    setEvidenceQuantities(Object.fromEntries((plan.evidenceForm?.lines ?? []).map((line) => [line.poLineId, String(line.maxQuantity)])));
    setConfirmationCommunicationId(asText(plan.confirmationEvidenceForm?.communications.at(0)?.id, ""));
    setConfirmationQuantities({});
    setConfirmationUnitPrices({});
    setConfirmationPromisedDates({});
    setProductionProgressReference("");
    setProductionProgressStatus("in_production");
    setProductionExpectedReadyAt("");
    setProductionNote("");
    setProductionQuantities({});
    setProductionPercentages({});
  };
  const selectedConfirmationCommunication = selectPoConfirmationCommunication(
    confirming?.confirmationEvidenceForm?.communications ?? [],
    confirmationCommunicationId,
  );
  const confirmationReplyAnalysis = useMemo(() => {
    const form = confirming?.confirmationEvidenceForm;
    if (!form || !selectedConfirmationCommunication) return null;
    const selectedIndex = form.communications.findIndex((communication) => communication.id === selectedConfirmationCommunication.id);
    return analyzeSupplierReply({
      communication: selectedConfirmationCommunication,
      earlierCommunications: selectedIndex < 0 ? [] : form.communications.slice(selectedIndex + 1),
      poLines: form.lines.map((line) => ({
        poLineId: line.poLineId,
        orderedQty: line.orderedQty,
        poUnitPrice: line.poUnitPrice,
        requestedAt: line.requestedAt,
        description: line.label,
        uom: line.uom,
      })),
    });
  }, [confirming?.confirmationEvidenceForm, selectedConfirmationCommunication]);
  const confirmationVariancePreview = useMemo(() => buildPoConfirmationVariancePreview({
    lines: confirming?.confirmationEvidenceForm?.lines ?? [],
    quantities: confirmationQuantities,
    unitPrices: confirmationUnitPrices,
    promisedDates: confirmationPromisedDates,
    timeZone: preferences.timeZone,
  }), [confirmationPromisedDates, confirmationQuantities, confirmationUnitPrices, confirming?.confirmationEvidenceForm?.lines, preferences.timeZone]);
  const fillConfirmationPoBaseline = () => {
    const form = confirming?.confirmationEvidenceForm;
    if (!form) return;
    const baseline = buildPoConfirmationBaselineValues(form.lines, preferences.timeZone);
    setConfirmationQuantities((current) => fillBlankPoConfirmationValues(current, baseline.quantities));
    setConfirmationUnitPrices((current) => fillBlankPoConfirmationValues(current, baseline.unitPrices));
    setConfirmationPromisedDates((current) => fillBlankPoConfirmationValues(current, baseline.promisedDates));
    setFeedback(null);
  };
  const fillConfirmationReplySuggestions = () => {
    if (!confirmationReplyAnalysis) return;
    const suggestions = buildSupplierReplySuggestionValues(confirmationReplyAnalysis);
    setConfirmationQuantities((current) => fillBlankPoConfirmationValues(current, suggestions.quantities));
    setConfirmationUnitPrices((current) => fillBlankPoConfirmationValues(current, suggestions.unitPrices));
    setConfirmationPromisedDates((current) => fillBlankPoConfirmationValues(current, suggestions.promisedDates));
    setFeedback(null);
  };
  const confirmingBusinessFact = Boolean(confirming?.confirmationEvidenceForm
    || confirming?.evidenceForm || confirming?.productionProgressForm || confirming?.transportEventForm);

  const queuePanel = <div className="min-h-[560px] space-y-3">
    {loading && !data ? <div className="flex min-h-[560px] items-center justify-center rounded-[14px] border border-[#e4eaf2] bg-white text-sm text-slate-400 shadow-[0_1px_3px_rgba(15,23,42,0.04)]"><Loader2 className="mr-2 size-4 animate-spin" />读取真实队列…</div> : filteredQueue.length ? visibleGroups.map((group) => <section key={group} className="overflow-hidden rounded-[14px] border border-[#e4eaf2] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2 px-5 pb-3 pt-5"><span className={cn("text-[18px] font-semibold", group === "exception" || group === "needs_action" ? "text-[#ef3e3e]" : group === "running" || group === "waiting_external" ? "text-[#2878ff]" : "text-emerald-600")}>{groupMeta[group].label}</span><span className={cn("text-[18px] font-semibold", group === "exception" || group === "needs_action" ? "text-[#ef3e3e]" : group === "running" || group === "waiting_external" ? "text-[#2878ff]" : "text-emerald-600")}>({grouped[group].length})</span></div>
      {group === "needs_action" || group === "exception" ? <div className="space-y-2 px-4 pb-4">{grouped[group].map((item) => {
        const exception = item.exceptions.find((entry) => ["open", "assigned"].includes(String(entry.status ?? "")));
        const approval = item.approvals[0];
        const firstLine = rows(item.po.lines)[0];
        const risk = riskLevel(item);
        const exceptionTitle = asText(exception?.type, approval ? "等待人工审批" : "待处理异常");
        const exceptionDetail = asText(exception?.aiJudgment, asText(approval?.message, currentWork(item)));
        const recommendation = asText(exception?.recommendedAction, nextStep(item));
        return <button type="button" key={asText(item.po.id)} onClick={(event) => selectQueueItem(item, event.currentTarget)} className={cn("grid min-h-[128px] w-full gap-5 rounded-xl border px-5 py-5 text-left transition xl:grid-cols-[1fr_1.2fr_1.05fr_1.2fr_.76fr] xl:items-center", selectedId === item.po.id ? "border-red-200 bg-[linear-gradient(108deg,#fff6f5_0%,#fffafa_100%)] ring-1 ring-inset ring-red-100" : "border-[#edf0f5] bg-white hover:border-red-100 hover:bg-red-50/30")}>
          <div className="min-w-0"><div className="truncate text-[15px] font-semibold text-[#13203a]">{asText(item.po.displayNumber, asText(item.po.number, asText(item.po.externalId, compactId(item.po.id))))}</div><div className="mt-3 text-[13px] font-semibold text-[#ef3e3e]">{exceptionTitle}</div></div>
          <div className="min-w-0"><div data-preserve-language className="truncate text-[14px] font-semibold text-[#26364f]">{asText(item.po.supplierName, compactId(item.po.supplierId))}</div><div className="mt-3 line-clamp-1 text-[12px] text-[#718198]"><TextValue value={hasDataText(firstLine?.description) ? firstLine?.description : firstLine?.itemId} fallback="未记录物料" />{asNumber(firstLine?.orderedQty) !== undefined ? ` × ${asNumber(firstLine?.orderedQty)}` : ""}</div></div>
          <div className="min-w-0"><div className="line-clamp-1 text-[14px] font-semibold text-[#ef3e3e]">{exceptionTitle}</div><div className="mt-2 line-clamp-2 text-[12px] leading-5 text-[#64748b]">{exceptionDetail}</div></div>
          <div className="min-w-0"><div className="text-[14px] font-semibold text-[#26364f]">AI 建议</div><div className="mt-2 line-clamp-2 text-[12px] leading-5 text-[#52627a]">{recommendation}</div></div>
          <div className="min-w-0 xl:text-right"><div className="text-[11px] font-medium text-[#94a3b8]">创建时间</div><div className="mt-2 text-[12px] text-[#64748b]">{formatTime(exception?.createdAt ?? approval?.requestedAt ?? item.po.updatedAt)}</div><span className={cn("mt-3 inline-flex rounded-full border px-2 py-1 text-[11px] font-semibold", risk === "high" ? "border-red-300 bg-red-50 text-red-500" : "border-amber-200 bg-amber-50 text-amber-700")}>{risk === "high" ? "高风险" : "中风险"}</span></div>
        </button>;
      })}</div> : <><div className="hidden grid-cols-[80px_110px_86px_minmax(0,1fr)] gap-2 border-b border-[#edf1f6] px-5 pb-2 text-[11px] font-medium text-[#7b8ba2] xl:grid 2xl:grid-cols-[88px_130px_90px_minmax(180px,1fr)_140px_44px]"><span>订单</span><span>供应商</span><span>当前阶段</span><span>AI 正在做什么</span><span className="hidden 2xl:block">下一步</span><span className="hidden 2xl:block">风险</span></div>
      <div className="divide-y divide-[#edf1f6] px-4 pb-2">{grouped[group].map((item) => {
        const risk = riskLevel(item);
        return <button type="button" key={asText(item.po.id)} onClick={(event) => selectQueueItem(item, event.currentTarget)} className={cn("grid min-h-[76px] w-full gap-2 rounded-lg px-1 py-3 text-left transition xl:grid-cols-[80px_110px_86px_minmax(0,1fr)] xl:items-center 2xl:grid-cols-[88px_130px_90px_minmax(180px,1fr)_140px_44px]", selectedId === item.po.id ? "bg-[#f7f9fc] ring-1 ring-inset ring-[#d6e1f0]" : "hover:bg-slate-50")}>
          <div className="min-w-0"><div className="truncate text-xs font-semibold text-[#13203a]">{asText(item.po.displayNumber, asText(item.po.number, asText(item.po.externalId, compactId(item.po.id))))}</div><div className="mt-1.5 text-[10px] text-slate-400">{formatTime(item.po.updatedAt)}</div></div>
          <div className="min-w-0"><div data-preserve-language className="truncate text-xs font-medium text-[#26364f]">{asText(item.po.supplierName, compactId(item.po.supplierId))}</div><div className="mt-1.5 truncate text-[10px] text-slate-400">{asText(item.po.currency, "币种未记录")}</div></div>
          <div><Badge tone={badgeTone(item.po.stage === "supplier_commitment" ? "awaiting_confirmation" : item.po.status)}>{asText(item.po.stageLabel, statusName(item.po.status))}</Badge></div>
          <div className="line-clamp-2 text-[11px] leading-[18px] text-[#52627a]">{currentWork(item)}</div>
          <div className="hidden items-center justify-between gap-1 text-[11px] font-medium leading-[18px] text-[#52627a] 2xl:flex"><span className="line-clamp-2">{nextStep(item)}</span><ChevronRight className="size-3.5 shrink-0 text-slate-300" /></div>
          <div className="hidden 2xl:block"><Badge tone={risk === "high" ? "red" : risk === "medium" ? "amber" : risk === "low" ? "blue" : "neutral"}>{risk === "high" ? "高" : risk === "medium" ? "中" : risk === "low" ? "低" : "—"}</Badge></div>
        </button>;
      })}</div></>}
    </section>) : <div className="flex min-h-[560px] flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white text-center shadow-sm"><PackageCheck className="size-8 text-slate-200" /><div className="mt-3 text-sm text-slate-400">没有匹配的真实 PO</div><button type="button" onClick={() => { setSearch(""); setRiskFilter("all"); setGroupFilter("all"); }} className="mt-3 text-xs font-medium text-blue-600 hover:underline">清除筛选</button></div>}
  </div>;

  return <div className={READYWORK_PAGE_CONTAINER_CLASS}>
    {resolvedDetailPresentation === "page" ? <main aria-label="采购订单详情" className="min-w-0">
      {error && data ? <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><span>后台刷新失败，当前显示上次读取的订单状态：{error}</span><button type="button" onClick={() => void refreshAll()} className="shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-2 font-semibold hover:bg-amber-100">重新获取最新状态</button></div> : null}
      {feedback && !confirming ? <div role={feedback.tone === "error" ? "alert" : "status"} className={cn("mb-4 rounded-xl border px-4 py-3 text-sm", feedback.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : feedback.tone === "pending" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-700")}>{feedback.text}</div> : null}
      {error && !data ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-5 text-sm text-red-700">{error}</div>
        : selected ? <DetailContent item={selected} detail={activeDetail} loading={detailLoading} error={detailError} tab={tab} setTab={selectDetailTab} actions={actions} onClose={() => onReturn?.()} onRetry={() => { if (selectedId) void loadDetail(selectedId); }} onRefresh={refreshAll} onAction={beginAction} onEdit={beginEditPurchaseOrder} onMarkAtRisk={beginMarkAtRisk} onDuplicate={beginDuplicatePurchaseOrder} onCancel={beginCancelPurchaseOrder} onResolveReadiness={(target) => target === "documents" ? selectDetailTab("documents") : onOpenSettings?.()} permissions={{ operate: data?.permissions?.operate, approve: data?.permissions?.approve }} navigationIntent={initialPurchaseOrderIntent} onNavigationIntentConsumed={onInitialPurchaseOrderConsumed} presentation="page" returnLabel={returnLabel} onPrevious={previousPurchaseOrder ? () => navigateToAdjacentPurchaseOrder(previousPurchaseOrder) : undefined} onNext={nextPurchaseOrder ? () => navigateToAdjacentPurchaseOrder(nextPurchaseOrder) : undefined} />
          : <div className="flex min-h-[560px] items-center justify-center rounded-[14px] border border-[#e4eaf2] bg-white text-sm text-slate-400">{loading ? <><Loader2 className="mr-2 size-4 animate-spin" />读取真实采购订单…</> : navigationNotice ?? "没有可读取的采购订单"}</div>}
    </main> : <>
    <div className="grid gap-x-3 xl:grid-cols-[minmax(0,1fr)_347px]">
    <header className="col-span-full flex min-h-[96px] flex-col justify-center gap-4 border-b border-[#e4eaf2] py-3 2xl:flex-row 2xl:items-center 2xl:justify-between xl:col-span-1">
      <div className="flex min-w-0 items-center gap-3">{onReturn && <button type="button" onClick={onReturn} aria-label={`返回${returnLabel ?? "来源页面"}`} className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#d9e1ec] bg-white text-[#52627a] transition hover:bg-slate-50 hover:text-[#13203a]"><ArrowLeft className="size-4" /></button>}<div className="min-w-0"><h1 className={READYWORK_PAGE_TITLE_CLASS}>采购订单</h1><p className="mt-1 truncate text-sm text-[#52627a]">AI 处理采购订单的确认、催交、异常和交付跟踪{onReturn ? ` · 返回${returnLabel ?? "来源页面"}` : ""}</p></div></div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex h-9 min-w-[230px] flex-1 items-center gap-2 rounded-lg border border-[#d9e1ec] bg-white px-3 2xl:w-[258px] 2xl:flex-none"><Search className="size-4 shrink-0 text-[#718198]" /><input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索 PO 任务" placeholder="搜索订单号/供应商/物料" className="min-w-0 flex-1 bg-transparent text-xs text-[#26364f] outline-none placeholder:text-[#8795a9]" /></div>
        <button type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((value) => !value)} className={cn("flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3.5 text-xs font-medium transition", filtersOpen || riskFilter !== "all" ? "border-[#071533] bg-[#071533] text-white" : "border-[#d9e1ec] bg-white text-[#26364f] hover:bg-slate-50")}><SlidersHorizontal className="size-4" />筛选</button>
      </div>
    </header>
    <div className="col-span-full flex min-h-[66px] flex-col justify-center border-b border-[#e4eaf2] bg-[#fbfcfe] xl:col-span-1">
      <div className="flex min-w-0 gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {filterTabs.map((item) => <button key={item.id} type="button" onClick={() => setGroupFilter(item.id)} className={cn("flex h-9 shrink-0 items-center gap-2 rounded-lg px-3.5 text-sm font-medium transition", groupFilter === item.id ? "bg-[#0b1020] text-white shadow-sm" : item.id === "exception" ? "text-red-500 hover:bg-red-50" : "text-slate-600 hover:bg-slate-100")}><span>{item.label}</span><span className={cn("rounded-md px-1.5 py-0.5 text-[11px]", groupFilter === item.id ? "bg-white/15 text-white" : "bg-slate-100 text-slate-400")}>{item.count === undefined ? "—" : item.count}</span></button>)}
      </div>
      {filtersOpen && <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-100 px-1 pt-2"><label className="flex items-center gap-2 text-xs font-medium text-slate-500"><span>风险</span><select value={riskFilter} onChange={(event) => setRiskFilter(event.target.value as RiskFilter)} className="h-8 rounded-lg border border-slate-200 bg-white px-3 text-xs text-slate-700 outline-none focus:border-slate-400"><option value="all">全部风险</option><option value="high">高风险</option><option value="medium">中风险</option><option value="low">低风险</option></select></label><button type="button" onClick={() => { setRiskFilter("all"); setSearch(""); }} className="text-xs font-medium text-slate-500 hover:text-slate-900">清除筛选</button><span className="ml-auto text-[11px] text-slate-400">每 15 秒读取一次真实状态</span></div>}
    </div>
    <div className="col-span-full min-h-0 xl:col-span-1">{error && <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</div>}{navigationNotice && <div className="mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800" role="status"><XCircle className="mt-1 size-4 shrink-0" /><span>{navigationNotice}</span></div>}{feedback && <div className={cn("mt-2 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm", feedback.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : feedback.tone === "pending" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-700")} role="status">{feedback.tone === "success" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : feedback.tone === "pending" ? <Clock3 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}<span>{feedback.text}</span></div>}
      <div className="min-w-0 pt-2.5">{queuePanel}</div>
    </div>
    <aside aria-label="任务详情" className={cn("min-w-0", detailOpen ? "fixed inset-0 z-50" : "hidden", "xl:sticky xl:top-2 xl:col-start-2 xl:row-start-1 xl:row-span-4 xl:block xl:h-[calc(100vh-16px)] xl:overflow-hidden xl:rounded-[14px] xl:border xl:border-[#e4eaf2] xl:bg-white xl:shadow-[0_1px_3px_rgba(15,23,42,0.04)]")}>
      <button type="button" aria-label="关闭详情" className="absolute inset-0 bg-slate-950/35 backdrop-blur-[1px] xl:hidden" onClick={() => setDetailOpen(false)} />
      <div ref={detailDialogRef} tabIndex={desktopDetailSurface ? undefined : -1} role={desktopDetailSurface ? "region" : "dialog"} aria-modal={desktopDetailSurface ? undefined : true} aria-labelledby="po-context-title" className="absolute inset-y-0 right-0 flex w-full max-w-2xl flex-col bg-white shadow-2xl sm:w-[92%] xl:static xl:h-full xl:max-w-none xl:shadow-none xl:w-full">
        <div className="min-h-0 flex-1 overflow-hidden">{selected && (detailVisible || detailOpen) ? <DetailContent item={selected} detail={activeDetail} loading={detailLoading} error={detailError} tab={tab} setTab={selectDetailTab} actions={actions} onClose={() => desktopDetailSurface ? setDetailVisible(false) : setDetailOpen(false)} onRetry={() => { if (selectedId) void loadDetail(selectedId); }} onRefresh={refreshAll} onAction={beginAction} onEdit={beginEditPurchaseOrder} onMarkAtRisk={beginMarkAtRisk} onDuplicate={beginDuplicatePurchaseOrder} onCancel={beginCancelPurchaseOrder} onResolveReadiness={(target) => target === "documents" ? selectDetailTab("documents") : onOpenSettings?.()} permissions={{ operate: data?.permissions?.operate, approve: data?.permissions?.approve }} navigationIntent={initialPurchaseOrderIntent} onNavigationIntentConsumed={onInitialPurchaseOrderConsumed} presentation="panel" /> : <div className="flex h-full min-h-[560px] items-center justify-center px-6 text-center text-sm text-slate-400">选择左侧 PO 查看任务详情</div>}</div>
      </div>
    </aside>
    </div>
    </>}

    <Dialog.Root open={editForm !== null} onOpenChange={(open) => { if (!open && !editSubmitting) setEditForm(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-slate-950/45 backdrop-blur-sm" />
        {editForm ? <Dialog.Content aria-describedby="edit-po-helper" onCloseAutoFocus={(event) => { const returnFocusElement = editReturnFocusRef.current; if (!returnFocusElement) return; event.preventDefault(); returnFocusElement.focus(); editReturnFocusRef.current = null; }} className="fixed left-1/2 top-1/2 z-[81] flex max-h-[92vh] w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[#dfe6ef] bg-white shadow-[0_24px_70px_rgba(15,27,51,0.24)]">
          <div className="flex items-start justify-between gap-4 border-b border-[#edf1f6] px-6 py-5"><div><Dialog.Title className="text-xl font-semibold tracking-[-0.025em] text-[#13203a]">{editForm.rihdOnly ? "修改要求到货日" : "编辑采购订单"}</Dialog.Title><Dialog.Description id="edit-po-helper" className="mt-1 text-xs leading-5 text-[#718198]">{editForm.rihdOnly ? "通过采购订单版本校验流程修改要求到货日。" : "修改当前采购订单的详细信息。"}</Dialog.Description></div><button type="button" aria-label="关闭编辑采购订单" disabled={editSubmitting} onClick={() => setEditForm(null)} className="flex size-9 shrink-0 items-center justify-center rounded-full text-[#62738d] transition hover:bg-slate-100 disabled:opacity-40"><X className="size-5" /></button></div>
          <form onSubmit={(event) => { event.preventDefault(); void submitEditPurchaseOrder(); }} className="min-h-0 flex flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">{editForm.external ? <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">此订单已在 Odoo/执行流程中；仅 RIHD 可通过权威 Odoo 写入与读回修改。</div> : null}<div className="grid grid-cols-2 gap-4">
              <label className="block"><span className="text-xs font-semibold text-[#34445d]">供应商名称</span><select data-preserve-language disabled={editForm.external} value={editForm.supplierId} onChange={(event) => { const nextSupplier = editForm.suppliers.find((supplier) => supplier.id === event.target.value); setEditForm((current) => current ? { ...current, supplierId: event.target.value, supplierName: nextSupplier?.name ?? "—", supplierEmail: nextSupplier?.email ?? "—", contactId: nextSupplier?.contacts[0]?.id ?? null, idempotencyKey: editPoIdempotencyKey(current.aggregateId), error: null } : current); }} className="mt-2 h-10 w-full rounded-xl border border-[#d9e1ec] bg-white px-3 text-sm text-[#26364f] outline-none focus:border-[#4f8cff] disabled:bg-[#f8faff] disabled:text-[#62738d]"><option value={editForm.supplierId}>{editForm.supplierName}</option>{editForm.suppliers.filter((supplier) => supplier.id !== editForm.supplierId).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
              <label className="block"><span className="text-xs font-semibold text-[#34445d]">供应商邮箱</span><input readOnly value={editForm.suppliers.find((supplier) => supplier.id === editForm.supplierId)?.email ?? editForm.supplierEmail} className="mt-2 h-10 w-full rounded-xl border border-[#e4eaf2] bg-[#f8faff] px-3 text-sm text-[#62738d]" /></label>
              <label className="block"><span className="text-xs font-semibold text-[#34445d]">联系人</span><select disabled={editForm.external} value={editForm.contactId ?? ""} onChange={(event) => setEditForm((current) => current ? { ...current, contactId: event.target.value || null, idempotencyKey: editPoIdempotencyKey(current.aggregateId), error: null } : current)} className="mt-2 h-10 w-full rounded-xl border border-[#d9e1ec] bg-white px-3 text-sm text-[#26364f] outline-none focus:border-[#4f8cff] disabled:bg-[#f8faff] disabled:text-[#62738d]"><option value="">未选择联系人</option>{editForm.suppliers.find((supplier) => supplier.id === editForm.supplierId)?.contacts.map((contact) => <option data-preserve-language key={contact.id} value={contact.id}>{contact.name}</option>)}</select></label>
              <label className="block"><span className="text-xs font-semibold text-[#34445d]">要求到货日</span><input required type="date" value={editForm.requiredInHouseAt} onChange={(event) => setEditForm((current) => current ? { ...current, requiredInHouseAt: event.target.value, idempotencyKey: editPoIdempotencyKey(current.aggregateId), error: null } : current)} className="mt-2 h-10 w-full rounded-xl border border-[#d9e1ec] bg-white px-3 text-sm text-[#26364f] outline-none focus:border-[#4f8cff]" /></label>
              <label className="col-span-2 block"><span className="text-xs font-semibold text-[#34445d]">物料 / 描述</span>{editForm.lines.map((line, index) => <div key={line.id} className="mt-2 grid grid-cols-[minmax(0,1fr)_92px_70px] gap-2"><input disabled={editForm.external} required value={line.description} onChange={(event) => setEditForm((current) => current ? { ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item), idempotencyKey: editPoIdempotencyKey(current.aggregateId), error: null } : current)} className="h-10 rounded-xl border border-[#d9e1ec] px-3 text-sm text-[#26364f] outline-none focus:border-[#4f8cff] disabled:bg-[#f8faff]" /><input disabled={editForm.external} required value={line.itemCode} onChange={(event) => setEditForm((current) => current ? { ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, itemCode: event.target.value } : item), idempotencyKey: editPoIdempotencyKey(current.aggregateId), error: null } : current)} aria-label="物料编码" className="h-10 rounded-xl border border-[#d9e1ec] px-3 text-sm text-[#26364f] outline-none focus:border-[#4f8cff] disabled:bg-[#f8faff]" /><input disabled={editForm.external} required min="0.0001" step="any" type="number" value={line.quantity} onChange={(event) => setEditForm((current) => current ? { ...current, lines: current.lines.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: Number(event.target.value) } : item), idempotencyKey: editPoIdempotencyKey(current.aggregateId), error: null } : current)} aria-label="数量" className="h-10 rounded-xl border border-[#d9e1ec] px-3 text-sm text-[#26364f] outline-none focus:border-[#4f8cff] disabled:bg-[#f8faff]" /></div>)}</label>
              <label className="block"><span className="text-xs font-semibold text-[#34445d]">物料类型</span><select disabled={editForm.external} value={editForm.materialType} onChange={(event) => setEditForm((current) => current ? { ...current, materialType: event.target.value as "direct" | "indirect", idempotencyKey: editPoIdempotencyKey(current.aggregateId), error: null } : current)} className="mt-2 h-10 w-full rounded-xl border border-[#d9e1ec] bg-white px-3 text-sm text-[#26364f] disabled:bg-[#f8faff] disabled:text-[#62738d]"><option value="direct">直接物料</option><option value="indirect">间接物料</option></select></label>
              <label className="block"><span className="text-xs font-semibold text-[#34445d]">阶段（只读）</span><input readOnly value={editForm.localizeStage ? translateReadyworkUiText(editForm.stage, interfaceLanguage) : editForm.stage} className="mt-2 h-10 w-full rounded-xl border border-[#e4eaf2] bg-[#f8faff] px-3 text-sm text-[#62738d]" /></label>
              <label className="block"><span className="text-xs font-semibold text-[#34445d]">状态（只读）</span><input readOnly value={editForm.localizeStatus ? translateReadyworkUiText(editForm.status, interfaceLanguage) : editForm.status} className="mt-2 h-10 w-full rounded-xl border border-[#e4eaf2] bg-[#f8faff] px-3 text-sm text-[#62738d]" /></label>
              <label className="block"><span className="text-xs font-semibold text-[#34445d]">修改原因</span><input required minLength={4} value={editForm.reason} onChange={(event) => setEditForm((current) => current ? { ...current, reason: event.target.value, idempotencyKey: editPoIdempotencyKey(current.aggregateId), error: null } : current)} className="mt-2 h-10 w-full rounded-xl border border-[#d9e1ec] px-3 text-sm text-[#26364f] outline-none focus:border-[#4f8cff]" /></label>
            </div>{editForm.serverVersion !== null ? <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">服务器当前版本为 {editForm.serverVersion}。请核对最新业务事实后再提交。</div> : null}{editForm.error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"><span>{editForm.error}</span></div> : null}</div>
            <div className="flex justify-end gap-2 border-t border-[#edf1f6] px-6 py-4"><Button type="button" variant="outline" disabled={editSubmitting} onClick={() => setEditForm(null)}>取消</Button><Button type="submit" disabled={editSubmitting || editForm.reason.trim().length < 4}>{editSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}{editSubmitting ? "正在保存…" : "保存修改"}</Button></div>
          </form>
        </Dialog.Content> : null}
      </Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root open={markAtRiskForm !== null} onOpenChange={(open) => { if (!open && !markAtRiskSubmitting) setMarkAtRiskForm(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[82] bg-slate-950/45 backdrop-blur-sm" />
        {markAtRiskForm ? <Dialog.Content aria-describedby="mark-at-risk-helper" onCloseAutoFocus={(event) => { const returnFocusElement = markAtRiskReturnFocusRef.current; if (!returnFocusElement) return; event.preventDefault(); returnFocusElement.focus(); markAtRiskReturnFocusRef.current = null; }} className="fixed left-1/2 top-1/2 z-[83] flex max-h-[92vh] w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-red-200 bg-white shadow-[0_24px_70px_rgba(15,27,51,0.28)]">
          <div className="flex items-start justify-between gap-4 border-b border-red-100 bg-red-50/55 px-6 py-5"><div><Dialog.Title className="text-xl font-semibold tracking-[-0.025em] text-[#13203a]">标记风险</Dialog.Title><Dialog.Description id="mark-at-risk-helper" className="mt-1 text-xs leading-5 text-[#718198]">为 <span data-preserve-language>{markAtRiskForm.purchaseOrderNumber}</span> 创建带版本的人工风险事实；此操作不会向供应商发送消息。</Dialog.Description></div><Dialog.Close asChild><button type="button" aria-label="关闭风险标记" disabled={markAtRiskSubmitting} className="flex size-9 shrink-0 items-center justify-center rounded-full text-[#62738d] transition hover:bg-red-100 disabled:opacity-40"><X className="size-5" /></button></Dialog.Close></div>
          <form onSubmit={(event) => { event.preventDefault(); void submitMarkAtRisk(); }} className="min-h-0 flex flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
              <div className="grid grid-cols-3 gap-3 rounded-xl border border-[#e4eaf2] bg-[#f8faff] p-4 text-xs"><Fact localize={["high", "medium", "low", "critical", "unknown"].includes(markAtRiskForm.currentRisk)} label="当前风险" value={({ high: "高风险", medium: "中风险", low: "低风险", critical: "严重风险", unknown: "未知" } as Record<string, string>)[markAtRiskForm.currentRisk] ?? markAtRiskForm.currentRisk} /><Fact localize={!!stageLabels[markAtRiskForm.stage]} label="阶段" value={stageDisplayLabel({ id: markAtRiskForm.stage, label: markAtRiskForm.stage })} /><Fact label="要求到货日" value={markAtRiskForm.requiredInHouseAt.slice(0, 10)} /></div>
              {!markAtRiskForm.ready ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800"><span>{markAtRiskForm.readinessMessage}</span></div> : <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700">此操作将追加不可变异常和审计事件，不会改变采购订单阶段，也不代表外部操作已成功。</div>}
              <div className="grid gap-4 sm:grid-cols-2"><label><span className="text-xs font-semibold text-[#34445d]">风险程度</span><select value={markAtRiskForm.riskSeverity} disabled={!markAtRiskForm.ready || markAtRiskSubmitting || Boolean(markAtRiskForm.resultId)} onChange={(event) => setMarkAtRiskForm((current) => current ? { ...current, riskSeverity: event.target.value as MarkAtRiskForm["riskSeverity"], error: null } : current)} className="mt-2 h-10 w-full rounded-xl border border-[#d9e1ec] bg-white px-3 text-sm"><option value="medium">中</option><option value="high">高</option><option value="critical">严重</option></select></label><label><span className="text-xs font-semibold text-[#34445d]">风险类别</span><select value={markAtRiskForm.riskCategory} disabled={!markAtRiskForm.ready || markAtRiskSubmitting || Boolean(markAtRiskForm.resultId)} onChange={(event) => setMarkAtRiskForm((current) => current ? { ...current, riskCategory: event.target.value as MarkAtRiskForm["riskCategory"], error: null } : current)} className="mt-2 h-10 w-full rounded-xl border border-[#d9e1ec] bg-white px-3 text-sm"><option value="schedule">排期</option><option value="supplier_response">供应商回复</option><option value="production">生产</option><option value="logistics">物流</option><option value="quality">质量</option><option value="commercial">商务</option><option value="compliance">合规</option><option value="other">其他</option></select></label></div>
              <label className="block"><span className="text-xs font-semibold text-[#34445d]">风险原因</span><textarea aria-label="风险原因" required minLength={4} value={markAtRiskForm.reason} readOnly={Boolean(markAtRiskForm.resultId)} disabled={!markAtRiskForm.ready || markAtRiskSubmitting} onChange={(event) => setMarkAtRiskForm((current) => current ? { ...current, reason: event.target.value, error: null } : current)} className="mt-2 min-h-24 w-full resize-none rounded-xl border border-[#d9e1ec] p-3 text-sm leading-6 outline-none focus:border-red-400" /></label>
              <label className="block"><span className="text-xs font-semibold text-[#34445d]">处置建议（可选）</span><textarea value={markAtRiskForm.recommendedAction} readOnly={Boolean(markAtRiskForm.resultId)} disabled={!markAtRiskForm.ready || markAtRiskSubmitting} onChange={(event) => setMarkAtRiskForm((current) => current ? { ...current, recommendedAction: event.target.value, error: null } : current)} className="mt-2 min-h-20 w-full resize-none rounded-xl border border-[#d9e1ec] p-3 text-sm leading-6 outline-none focus:border-red-400" /></label>
              {markAtRiskForm.resultId ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-800">人工风险事实已保存，编号为 <span data-preserve-language className="font-mono">{markAtRiskForm.resultId}</span>。已重新读取权威采购订单数据。</div> : null}
              {markAtRiskForm.error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700"><span>{markAtRiskForm.error}</span></div> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-[#edf1f6] px-6 py-4"><Dialog.Close asChild><Button type="button" variant="outline" disabled={markAtRiskSubmitting}>关闭</Button></Dialog.Close>{!markAtRiskForm.resultId ? <Button type="submit" disabled={!markAtRiskForm.ready || markAtRiskSubmitting || markAtRiskForm.reason.trim().length < 4} className="bg-red-600 text-white hover:bg-red-700">{markAtRiskSubmitting ? <Loader2 className="size-4 animate-spin" /> : <AlertTriangle className="size-4" />}{markAtRiskSubmitting ? "正在保存…" : "标记风险"}</Button> : null}</div>
          </form>
        </Dialog.Content> : null}
      </Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root open={cancelDialogOpen && cancelForm !== null} onOpenChange={(open) => { if (!open && !cancelSubmitting) setCancelDialogOpen(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[82] bg-slate-950/50 backdrop-blur-sm" />
        {cancelForm ? <Dialog.Content aria-describedby="cancel-po-helper" onOpenAutoFocus={(event) => { event.preventDefault(); window.requestAnimationFrame(() => cancelReasonRef.current?.focus({ preventScroll: true })); }} onCloseAutoFocus={(event) => { const returnFocusElement = cancelReturnFocusRef.current; if (!returnFocusElement) return; event.preventDefault(); returnFocusElement.focus(); }} className="fixed left-1/2 top-1/2 z-[83] flex max-h-[92vh] w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-red-200 bg-white shadow-[0_24px_70px_rgba(15,27,51,0.28)]">
          <div className="flex items-start justify-between gap-4 border-b border-red-100 bg-red-50/60 px-6 py-5"><div><div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.13em] text-red-600"><AlertTriangle className="size-3.5" />危险操作</div><Dialog.Title className="mt-1.5 text-xl font-semibold tracking-[-0.025em] text-[#13203a]">取消采购订单</Dialog.Title><Dialog.Description id="cancel-po-helper" className="mt-1 text-xs leading-5 text-[#718198]">请先核对已保存的履约事实和外部系统读回状态，再决定是否取消。</Dialog.Description></div><Dialog.Close asChild><button type="button" aria-label="关闭取消采购订单" disabled={cancelSubmitting} className="flex size-9 shrink-0 items-center justify-center rounded-full text-[#62738d] transition hover:bg-red-100 disabled:opacity-40"><X className="size-5" /></button></Dialog.Close></div>
          <form onSubmit={(event) => { event.preventDefault(); void submitCancelPurchaseOrder(); }} className="min-h-0 flex flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-[#e4eaf2] bg-[#f8faff] p-4 text-xs"><div><div className="text-[10px] text-[#8795a9]">采购订单</div><div data-preserve-language className="mt-1 break-all font-semibold text-[#26364f]">{cancelForm.purchaseOrderNumber}</div></div><div><div className="text-[10px] text-[#8795a9]">来源</div><div className="mt-1 font-semibold text-[#26364f]">{cancelForm.sourceSystem === "readywork" ? "Readywork" : "Odoo / 外部系统"}</div></div><div><div className="text-[10px] text-[#8795a9]">预期版本</div><div className="mt-1 font-mono font-semibold text-[#26364f]">v{cancelForm.expectedVersion}</div></div><div><div className="text-[10px] text-[#8795a9]">操作影响</div><div className="mt-1 font-semibold text-red-700">追加取消记录</div></div></div>
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-800"><div className="font-semibold">取消会停止后续采购执行</div><p className="mt-1">不会删除 PO、行项目、文档或历史；取消原因、状态和外部回执会继续保留在审计链中。</p></div>
              {cancelForm.blockers.length === 0
                ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-800"><CheckCircle2 className="mr-2 inline size-4" />尚未发现发运、收货 GRN 或发票阻断；服务器会在提交时再次权威校验。</div>
                : <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-800"><div className="font-semibold">当前事实已阻断取消</div><ul className="mt-2 list-disc space-y-1 pl-5">{cancelForm.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
              <label className="block"><span className="text-xs font-semibold text-[#34445d]">取消原因 <span className="text-red-500">*</span></span><textarea ref={cancelReasonRef} required minLength={4} maxLength={1000} aria-label="取消原因" readOnly={cancelForm.result !== null} value={cancelForm.reason} onChange={(event) => setCancelForm((current) => current ? { ...current, reason: event.target.value, error: null } : current)} placeholder="说明取消原因和已获得的审批依据。" className="mt-2 min-h-24 w-full resize-none rounded-xl border border-[#d9e1ec] bg-white p-3 text-sm leading-6 text-[#26364f] outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-100 read-only:bg-[#f8faff]" /><span className="mt-1.5 block text-[10px] leading-4 text-[#8795a9]">至少 4 个字符；提交后为保证幂等对账将不再允许修改。</span></label>
              <div className="rounded-lg bg-[#f7f9fc] px-3 py-2 text-[10px] leading-5 text-[#718198]">幂等请求：<span data-preserve-language className="break-all font-mono text-[#52627a]">{cancelForm.idempotencyKey}</span></div>
              {cancelForm.result ? <div ref={cancelStatusRef} role="status" className={cn("rounded-xl border px-4 py-3 text-xs leading-5", cancelForm.result.status === "pending_external" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-800")}><div className="flex items-center gap-2 font-semibold">{cancelForm.result.status === "pending_external" ? <Clock3 className="size-4" /> : <AlertTriangle className="size-4" />}{cancelForm.result.status === "pending_external" ? "等待外部回执" : cancelForm.result.status === "unknown" ? "需要处理" : "取消失败"}</div><div className="mt-2 break-all">请求编号：<span data-preserve-language className="font-mono">{cancelForm.result.requestId}</span></div><div className="break-all">发件队列编号：<span className="font-mono">{cancelForm.result.outboxId ?? "暂无"}</span></div>{cancelForm.result.status === "pending_external" ? <p className="mt-2">Odoo 操作已排队；只有权威读回 cancelled 后，Readywork 才会投影已取消。</p> : cancelForm.result.status === "unknown" ? <p className="mt-2 font-semibold">外部结果无法确认。不要使用新请求编号重复取消；请使用下方按钮保持同一请求身份对账。</p> : <p className="mt-2">Odoo 已明确拒绝，本地 PO 未被标记为已取消。</p>}</div> : null}
              {cancelForm.error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700"><span>{cancelForm.error}</span></div> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-[#edf1f6] px-6 py-4"><Dialog.Close asChild><Button type="button" variant="outline" disabled={cancelSubmitting}>关闭</Button></Dialog.Close>{cancelForm.result?.status === "pending_external" || cancelForm.result?.status === "unknown" ? <Button type="submit" variant="outline" disabled={cancelSubmitting}>{cancelSubmitting ? <Loader2 className="size-4 animate-spin" /> : null}{cancelSubmitting ? "正在核对…" : "核对状态"}</Button> : cancelForm.result === null ? <Button type="submit" disabled={cancelSubmitting || cancelForm.blockers.length > 0 || cancelForm.reason.trim().length < 4} className="bg-red-600 text-white hover:bg-red-700">{cancelSubmitting ? <Loader2 className="size-4 animate-spin" /> : <XCircle className="size-4" />}{cancelSubmitting ? "正在取消…" : "取消采购订单"}</Button> : null}</div>
          </form>
        </Dialog.Content> : null}
      </Dialog.Portal>
    </Dialog.Root>

    {duplicateForm && <Dialog.Root open onOpenChange={(open) => { if (!open && !duplicateSubmitting) setDuplicateForm(null); }}><Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[70] bg-slate-950/45 backdrop-blur-sm" />
      <Dialog.Content asChild aria-describedby="duplicate-po-description" onCloseAutoFocus={(event) => { event.preventDefault(); duplicateReturnFocusRef.current?.focus(); }} onEscapeKeyDown={(event) => { if (duplicateSubmitting) event.preventDefault(); }} onPointerDownOutside={(event) => { if (duplicateSubmitting) event.preventDefault(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void submitDuplicatePurchaseOrder(); }} aria-labelledby="duplicate-po-title" className="fixed left-1/2 top-1/2 z-[71] flex max-h-[92vh] w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-[#dfe6ef] bg-white shadow-[0_24px_70px_rgba(15,27,51,0.24)]">
        <div className="flex items-start justify-between gap-4 border-b border-[#edf1f6] px-6 py-5"><div><div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.13em] text-[#397560]"><Copy className="size-3.5" />采购订单操作</div><Dialog.Title id="duplicate-po-title" className="mt-1.5 text-xl font-semibold tracking-[-0.025em] text-[#13203a]">复制采购订单</Dialog.Title><Dialog.Description id="duplicate-po-description" className="mt-1 text-xs leading-5 text-[#718198]">复制订单内容并生成一张独立、未发送的 Readywork 采购订单草稿。</Dialog.Description></div><button type="button" aria-label="关闭复制采购订单" disabled={duplicateSubmitting} onClick={() => setDuplicateForm(null)} className="flex size-9 shrink-0 items-center justify-center rounded-lg text-[#62738d] transition hover:bg-slate-100 disabled:opacity-40"><X className="size-5" /></button></div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-[#e4eaf2] bg-[#f8faff] p-4 text-xs"><div><div className="text-[10px] text-[#8795a9]">源 PO</div><div data-preserve-language className="mt-1 break-all font-semibold text-[#26364f]">{duplicateForm.purchaseOrderNumber}</div></div><div><div className="text-[10px] text-[#8795a9]">供应商</div><div data-preserve-language className="mt-1 truncate font-semibold text-[#26364f]">{duplicateForm.supplierName}</div></div><div><div className="text-[10px] text-[#8795a9]">复制行数</div><div className="mt-1 font-semibold text-[#26364f]">{duplicateForm.lineCount} 行</div></div><div><div className="text-[10px] text-[#8795a9]">源版本</div><div className="mt-1 font-mono font-semibold text-[#26364f]">v{duplicateForm.expectedVersion}</div></div></div>
          <label className="block"><span className="text-xs font-semibold text-[#34445d]">新 PO 编号 <span className="text-red-500">*</span></span><input autoFocus required maxLength={120} value={duplicateForm.newPurchaseOrderNumber} onChange={(event) => setDuplicateForm((current) => current ? { ...current, newPurchaseOrderNumber: event.target.value, idempotencyKey: duplicatePoIdempotencyKey(current.aggregateId), error: null } : current)} placeholder="例如 PO-2026-0901-02" className="mt-2 h-10 w-full rounded-xl border border-[#d9e1ec] bg-white px-3 text-sm text-[#26364f] outline-none transition focus:border-[#4f8cff] focus:ring-2 focus:ring-blue-100" /><span className="mt-1.5 block text-[10px] leading-4 text-[#8795a9]">新编号必须在当前租户内唯一。</span></label>
          <label className="block"><span className="text-xs font-semibold text-[#34445d]">RIHD 要求到货日 <span className="text-red-500">*</span></span><input type="date" required value={duplicateForm.newRequiredInHouseAt} onChange={(event) => setDuplicateForm((current) => current ? { ...current, newRequiredInHouseAt: event.target.value, idempotencyKey: duplicatePoIdempotencyKey(current.aggregateId), error: null } : current)} className="mt-2 h-10 w-full rounded-xl border border-[#d9e1ec] bg-white px-3 text-sm text-[#26364f] outline-none transition focus:border-[#4f8cff] focus:ring-2 focus:ring-blue-100" /></label>
          <label className="block"><span className="text-xs font-semibold text-[#34445d]">复制原因 <span className="text-red-500">*</span></span><textarea required minLength={4} maxLength={1000} value={duplicateForm.reason} onChange={(event) => setDuplicateForm((current) => current ? { ...current, reason: event.target.value, idempotencyKey: duplicatePoIdempotencyKey(current.aggregateId), error: null } : current)} placeholder="说明为什么需要一张新 PO，该内容会进入审计时间线。" className="mt-2 min-h-24 w-full resize-none rounded-xl border border-[#d9e1ec] bg-white p-3 text-sm leading-6 text-[#26364f] outline-none transition focus:border-[#4f8cff] focus:ring-2 focus:ring-blue-100" /></label>
          <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-4 text-[11px] leading-5 text-[#36577e]"><div className="font-semibold text-[#254a77]">将复制</div><p className="mt-1">供应商、币种、物料、数量、单价和税务字段；所有行将使用新 ID 和新 RIHD。</p><div className="mt-3 font-semibold text-[#254a77]">不会继承</div><p className="mt-1">Odoo 映射、RFQ / Award / 采购需求关系、附件、供应商确认、生产、发运、收货、异常或历史沟通。</p></div>
          <div className="rounded-lg bg-[#f7f9fc] px-3 py-2 text-[10px] leading-5 text-[#718198]">请求编号：<span data-preserve-language className="break-all font-mono text-[#52627a]">{duplicateForm.idempotencyKey}</span><br />只有 SQLite 事务提交后才会显示成功；不发邮件、不写 Odoo、不推进源 PO。</div>
          {duplicateForm.error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700"><span>{duplicateForm.error}</span></div> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-[#edf1f6] px-6 py-4"><Button type="button" variant="outline" disabled={duplicateSubmitting} onClick={() => setDuplicateForm(null)}>取消</Button><Button type="submit" disabled={duplicateSubmitting || !duplicateForm.newPurchaseOrderNumber.trim() || !duplicateForm.newRequiredInHouseAt || duplicateForm.reason.trim().length < 4}>{duplicateSubmitting ? <Loader2 className="size-4 animate-spin" /> : <Copy className="size-4" />}{duplicateSubmitting ? "正在持久化…" : "创建采购订单草稿"}</Button></div>
      </form></Dialog.Content>
    </Dialog.Portal></Dialog.Root>}

    {confirming && <Dialog.Root open onOpenChange={(open) => { if (!open && !submitting) setConfirming(null); }}><Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[60] bg-slate-950/45 backdrop-blur-sm" />
      <Dialog.Content aria-labelledby="confirm-action-title" aria-describedby="confirm-action-description" onCloseAutoFocus={(event) => { event.preventDefault(); const target = confirmReturnFocusRef.current; if (target?.isConnected) target.focus(); else document.querySelector<HTMLButtonElement>("[data-po-actions-trigger]")?.focus(); }} onEscapeKeyDown={(event) => { if (submitting) event.preventDefault(); }} onPointerDownOutside={(event) => { if (submitting) event.preventDefault(); }} className="fixed left-1/2 top-1/2 z-[61] flex max-h-[92vh] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-5"><div><div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#397560]">{confirmingBusinessFact ? "业务事实确认" : "外部副作用确认"}</div><Dialog.Title id="confirm-action-title" className="mt-1 text-lg font-semibold text-slate-950">{confirming.label}</Dialog.Title><Dialog.Description id="confirm-action-description" className="mt-1 text-sm leading-6 text-slate-500">{confirming.description}</Dialog.Description></div><Button variant="ghost" size="icon" aria-label="关闭操作确认" disabled={submitting} onClick={() => setConfirming(null)}><X className="size-4" /></Button></div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {confirming.confirmationEvidenceForm && <div className="space-y-4 rounded-2xl border border-[#dce5f0] bg-[#f8faff] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#26364f]"><Inbox className="size-4 text-blue-600" />从真实供应商回复登记结构化确认</div>
            <label className="block">
              <span className="text-xs font-medium text-slate-700">原始入站回复 <span className="text-red-500">*</span></span>
              <select value={confirmationCommunicationId} onChange={(event) => { setConfirmationCommunicationId(event.target.value); setFeedback(null); }} className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400">
                <option value="">选择一封已关联当前 PO 的回复</option>
                {confirming.confirmationEvidenceForm.communications.map((communication) => <option key={communication.id} value={communication.id}>{communication.subject} · {communication.from} · {formatTime(communication.receivedAt)}</option>)}
              </select>
            </label>
            {selectedConfirmationCommunication ? <section aria-label="原始供应商邮件正文" className="overflow-hidden rounded-xl border border-blue-100 bg-white">
              <div className="border-b border-blue-50 bg-blue-50/60 px-3 py-3">
                <div data-preserve-language className="text-xs font-semibold text-slate-900">{selectedConfirmationCommunication.subject}</div>
                <dl className="mt-2 grid gap-x-4 gap-y-1 text-[11px] leading-5 text-slate-600 sm:grid-cols-2">
                  <div><dt className="inline text-slate-400">发件人：</dt><dd className="inline break-all">{selectedConfirmationCommunication.from}</dd></div>
                  <div><dt className="inline text-slate-400">接收时间：</dt><dd className="inline">{formatTime(selectedConfirmationCommunication.receivedAt)}</dd></div>
                  <div className="sm:col-span-2"><dt className="inline text-slate-400">Message-ID：</dt><dd className="inline break-all font-mono text-slate-700">{selectedConfirmationCommunication.messageId ?? "未记录"}</dd></div>
                  <div className="sm:col-span-2"><dt className="inline text-slate-400">证据 ID：</dt><dd className="inline break-all font-mono text-slate-700">{selectedConfirmationCommunication.id}</dd></div>
                </dl>
              </div>
              <div className="px-3 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">邮件完整正文 · 只读</div>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 font-sans text-xs leading-6 text-slate-700">{selectedConfirmationCommunication.body || "该通信没有可用的文本正文。"}</pre>
              </div>
              <div className="border-t border-blue-50 px-3 py-2 text-[10px] leading-5 text-slate-500">后端会重新校验该通信的租户、PO、供应商、方向和接收状态；前端选择本身不能冒充证据。</div>
            </section> : null}
            {confirmationReplyAnalysis ? <section aria-label="供应商回复结构化解析建议" className="overflow-hidden rounded-xl border border-[#d7e5f7] bg-white">
              <div className="flex items-start justify-between gap-4 border-b border-[#e6eef8] bg-[#f6f9fe] px-4 py-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[#17345f]"><CheckCircle2 className="size-4 text-blue-600" />结构化解析建议<span className="rounded-full border border-blue-100 bg-white px-2 py-0.5 text-[9px] font-semibold text-blue-700">0 模型 token</span>{confirmationReplyAnalysis.quotedSectionRemoved ? <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[9px] font-medium text-slate-600">已排除引用原邮件</span> : null}</div>
                  <div className="mt-1 text-[10px] leading-5 text-[#65748a]">确定性规则只生成待核对建议，不会保存、提交、回写 Odoo 或推进 PO 阶段。</div>
                </div>
                <Button type="button" variant="outline" size="sm" disabled={submitting || confirmationReplyAnalysis.reliableSuggestionCount === 0} onClick={fillConfirmationReplySuggestions}><FileText className="size-3.5" />将可靠建议填入空白项</Button>
              </div>
              <div className="space-y-3 px-4 py-3">
                <div className="grid grid-cols-3 gap-2">
                  {confirmationReplyAnalysis.lineSuggestions.length === 1 ? <>
                    <ReplySuggestionMetric label="确认数量" value={confirmationReplyAnalysis.lineSuggestions[0]?.quantity ? `${confirmationReplyAnalysis.lineSuggestions[0].quantity.value} ${confirming.confirmationEvidenceForm.lines[0]?.uom ?? ""}` : "未可靠提取"} confidence={confirmationReplyAnalysis.lineSuggestions[0]?.quantity?.confidence} />
                    <ReplySuggestionMetric label="确认单价" value={confirmationReplyAnalysis.lineSuggestions[0]?.unitPrice ? `${confirmationReplyAnalysis.lineSuggestions[0].unitPrice.value} ${confirming.confirmationEvidenceForm.lines[0]?.currency ?? ""}` : "回复未提及"} confidence={confirmationReplyAnalysis.lineSuggestions[0]?.unitPrice?.confidence} />
                    <ReplySuggestionMetric label="承诺交期" value={confirmationReplyAnalysis.lineSuggestions[0]?.promisedDate?.value ?? "未可靠提取"} confidence={confirmationReplyAnalysis.lineSuggestions[0]?.promisedDate?.confidence} />
                  </> : <div className="col-span-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-[10px] leading-5 text-amber-800">回复没有将字段明确绑定到某一条 PO 行，未生成可填入的行级值。</div>}
                </div>
                {confirmationReplyAnalysis.evidence.length ? <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-400">建议证据片段</div>
                  <div className="mt-1.5 space-y-1 text-[10px] leading-5 text-slate-600">{confirmationReplyAnalysis.evidence.map((item, index) => <div key={`${item.field}-${item.raw}-${index}`}><span className="font-semibold text-slate-700">{supplierReplyFieldLabel(item.field)}：</span>“{item.evidence}”</div>)}</div>
                </div> : null}
                {confirmationReplyAnalysis.conflicts.length ? <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-800"><AlertTriangle className="size-3.5" />必须人工核对的冲突 / 歧义</div>
                  <ul className="mt-1.5 space-y-1 text-[10px] leading-5 text-amber-800">{confirmationReplyAnalysis.conflicts.map((conflict, index) => <li key={`${conflict.code}-${conflict.raw}-${index}`} className="flex gap-1.5"><span aria-hidden="true">•</span><span>{conflict.message}{conflict.sourceCommunicationId ? <span className="ml-1 font-mono text-[9px] text-amber-700">{compactId(conflict.sourceCommunicationId)}</span> : null}</span></li>)}</ul>
                </div> : null}
                <div className="text-[10px] leading-5 text-slate-500">仍需人工明确：{confirmationReplyAnalysis.missingFields.length ? confirmationReplyAnalysis.missingFields.map(supplierReplyFieldLabel).join("、") : "所有字段都已提取，但仍需与原邮件逐项核对"}。</div>
              </div>
            </section> : null}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-700">逐行确认事实</div>
                <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={fillConfirmationPoBaseline}><FileText className="size-3.5" />按 PO 原值填入未变更项</Button>
              </div>
              <div className="mt-1 text-[10px] leading-5 text-slate-500">仅填充当前空白项，不会覆盖已录入的差异，也不会保存或提交。交期按租户时区 {preferences.timeZone} 转换。</div>
              <div className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="hidden grid-cols-[minmax(0,1fr)_90px_110px_140px] gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2 text-[10px] font-semibold text-slate-500 md:grid"><span>PO 行</span><span>确认数量</span><span>确认单价</span><span>承诺交期</span></div>{confirming.confirmationEvidenceForm.lines.map((line) => <div key={line.poLineId} className="grid gap-2 border-b border-slate-100 px-3 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_90px_110px_140px] md:items-center"><div className="min-w-0"><div className="truncate text-xs font-medium text-slate-800"><span data-preserve-language={"labelIsFallback" in line && line.labelIsFallback ? undefined : true}>{line.label}</span></div><div className="mt-1 text-[10px] text-slate-400">PO：{line.orderedQty} <span data-preserve-language>{line.uom}</span> · {line.poUnitPrice ?? "—"} {line.currency} · 原交期 {line.requestedAt ? formatTime(line.requestedAt) : "未记录"}</div></div><input type="number" min="0" step="any" aria-label={`${line.label} 供应商确认数量`} value={confirmationQuantities[line.poLineId] ?? ""} onChange={(event) => setConfirmationQuantities((current) => ({ ...current, [line.poLineId]: event.target.value }))} placeholder={String(line.orderedQty)} className="h-9 w-full rounded-lg border border-slate-200 px-2 text-right text-sm font-semibold outline-none focus:border-blue-400" /><input type="number" min="0" step="any" aria-label={`${line.label} 供应商确认单价`} value={confirmationUnitPrices[line.poLineId] ?? ""} onChange={(event) => setConfirmationUnitPrices((current) => ({ ...current, [line.poLineId]: event.target.value }))} placeholder={line.poUnitPrice === null ? "必填" : String(line.poUnitPrice)} className="h-9 w-full rounded-lg border border-slate-200 px-2 text-right text-sm font-semibold outline-none focus:border-blue-400" /><input type="date" aria-label={`${line.label} 供应商承诺交期`} value={confirmationPromisedDates[line.poLineId] ?? ""} onChange={(event) => setConfirmationPromisedDates((current) => ({ ...current, [line.poLineId]: event.target.value }))} className="h-9 w-full rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-blue-400" /></div>)}</div>
            </div>
            <section aria-label="供应商确认提交前差异预览" className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
                <div><div className="flex items-center gap-2 text-sm font-semibold text-slate-800"><ShieldCheck className="size-4 text-blue-600" />提交前差异预检</div><div className="mt-1 text-[10px] leading-5 text-slate-500">仅基于当前输入与 PO 原值实时计算，不保存、不提交，也不产生新的业务事实。</div></div>
                <div className="flex flex-wrap gap-1.5 text-[10px] font-medium"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">完整 {confirmationVariancePreview.completeLineCount}/{confirmationVariancePreview.totalLineCount}</span><span className={cn("rounded-full px-2.5 py-1", confirmationVariancePreview.varianceLineCount ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700")}>差异 {confirmationVariancePreview.varianceLineCount}</span><span className={cn("rounded-full px-2.5 py-1", confirmationVariancePreview.approvalLineCount ? "bg-red-50 text-red-700" : "bg-slate-100 text-slate-600")}>预计审批 {confirmationVariancePreview.approvalLineCount}</span></div>
              </div>
              <div className="divide-y divide-slate-100">
                {confirmationVariancePreview.rows.map((row) => <div key={row.poLineId} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-xs font-semibold text-slate-800">{row.label}</div><span className={cn("rounded-full px-2 py-0.5 text-[9px] font-semibold", !row.complete ? "bg-slate-100 text-slate-500" : row.requiresApproval === true ? "bg-red-50 text-red-700" : row.requiresApproval === null ? "bg-amber-50 text-amber-700" : row.hasVariance ? "bg-blue-50 text-blue-700" : "bg-emerald-50 text-emerald-700")}>{!row.complete ? "待填写" : row.requiresApproval === true ? "预计进入审批" : row.requiresApproval === null ? "基准不完整" : row.hasVariance ? "有差异 · 未命中审批规则" : "无差异"}</span></div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <div className="rounded-xl bg-slate-50 px-3 py-2"><div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-400">数量</div><div className="mt-1 text-[11px] text-slate-700"><span className="text-slate-400">PO</span> {row.orderedQty} {row.uom} <span className="px-1 text-slate-300">→</span> <span className={row.confirmedQty === null ? "text-slate-400" : "font-semibold text-slate-800"}>{row.confirmedQty ?? "待填写"}</span>{row.confirmedQty === null ? null : ` ${row.uom}`}</div><div className={cn("mt-1 text-[10px] font-medium", row.quantityVariance === null ? "text-slate-400" : row.quantityVariance === 0 ? "text-emerald-600" : "text-red-600")}>差异 {formatVariance(row.quantityVariance, row.quantityVariance === null ? "" : ` ${row.uom}`)}</div></div>
                    <div className="rounded-xl bg-slate-50 px-3 py-2"><div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-400">单价</div><div className="mt-1 text-[11px] text-slate-700"><span className="text-slate-400">PO</span> {row.poUnitPrice === null ? "未知" : `${row.poUnitPrice} ${row.currency}`} <span className="px-1 text-slate-300">→</span> <span className={row.confirmedUnitPrice === null ? "text-slate-400" : "font-semibold text-slate-800"}>{row.confirmedUnitPrice === null ? "待填写" : `${row.confirmedUnitPrice} ${row.currency}`}</span></div><div className={cn("mt-1 text-[10px] font-medium", row.unitPriceVariance === null ? "text-slate-400" : row.unitPriceVariance === 0 ? "text-emerald-600" : "text-red-600")}>差异 {formatVariance(row.unitPriceVariance, row.unitPriceVariance === null ? "" : ` ${row.currency}`)}{row.unitPriceVariancePercent === null ? "" : ` (${formatVariance(Number(row.unitPriceVariancePercent.toFixed(2)), "%")})`}</div></div>
                    <div className="rounded-xl bg-slate-50 px-3 py-2"><div className="text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-400">承诺交期</div><div className="mt-1 text-[11px] text-slate-700"><span className="text-slate-400">PO</span> {row.requestedDate ?? "未知"} <span className="px-1 text-slate-300">→</span> <span className={row.promisedDate === null ? "text-slate-400" : "font-semibold text-slate-800"}>{row.promisedDate ?? "待填写"}</span></div><div className={cn("mt-1 text-[10px] font-medium", row.promisedAtVarianceDays === null ? "text-slate-400" : row.promisedAtVarianceDays === 0 ? "text-emerald-600" : row.promisedAtVarianceDays > SUPPLIER_CONFIRMATION_PROMISED_DELAY_APPROVAL_DAYS ? "text-red-600" : "text-blue-600")}>差异 {formatVariance(row.promisedAtVarianceDays, row.promisedAtVarianceDays === null ? "" : " 天")}</div></div>
                  </div>
                  {!row.complete ? <div className="mt-2 text-[10px] text-slate-500">待填写或修正：{row.missingFields.map((field) => field === "quantity" ? "确认数量" : field === "unitPrice" ? "确认单价" : "承诺交期").join("、")}</div> : null}
                </div>)}
              </div>
              <div aria-live="polite" className={cn("border-t px-4 py-3 text-[11px] font-medium leading-5", !confirmationVariancePreview.allComplete ? "border-slate-100 bg-slate-50 text-slate-600" : confirmationVariancePreview.wouldCreateApproval === true ? "border-red-100 bg-red-50 text-red-700" : confirmationVariancePreview.wouldDirectlyConfirm ? "border-emerald-100 bg-emerald-50 text-emerald-700" : "border-amber-100 bg-amber-50 text-amber-700")}>
                {!confirmationVariancePreview.allComplete
                  ? "填写全部行后才会给出提交结果预判；空值不会被解释为 0 或沿用 PO。"
                  : confirmationVariancePreview.wouldCreateApproval === true
                    ? "提交后将保存供应商确认事实并创建人工审批；批准前不会更新承诺累计，也不会进入生产阶段。"
                    : confirmationVariancePreview.wouldDirectlyConfirm
                      ? confirmationVariancePreview.varianceLineCount === 0 ? "当前输入未发现差异；后端重新校验全部证据与版本后，才可能直接确认并进入生产阶段。" : "当前差异未命中人工审批规则；后端重新校验全部证据与版本后，才可能直接确认并进入生产阶段。"
                      : "PO 对比基准不完整，前端无法可靠预判审批结果；提交后仍以后端权威校验为准。"}
              </div>
            </section>
            <div className="text-[11px] leading-5 text-[#65748a]">数量、单价和交期均需由人明确核对。数量或单价变化、以及交期延后超过 {SUPPLIER_CONFIRMATION_PROMISED_DELAY_APPROVAL_DAYS} 天会创建待审批记录；最终结果仍由后端按最新 PO 版本重新计算。</div>
          </div>}
          {confirming.productionProgressForm && <div className="space-y-4 rounded-2xl border border-[#dce5f0] bg-[#f8faff] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#26364f]"><PackageCheck className="size-4 text-blue-600" />人工核验生产 / 备货进度</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="sm:col-span-2"><span className="text-xs font-medium text-slate-700">进度证据编号 <span className="text-red-500">*</span></span><input value={productionProgressReference} onChange={(event) => setProductionProgressReference(event.target.value)} maxLength={120} placeholder="供应商进度邮件、报告或会议纪要编号" className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
              <label><span className="text-xs font-medium text-slate-700">本次状态 <span className="text-red-500">*</span></span><select value={productionProgressStatus} onChange={(event) => setProductionProgressStatus(event.target.value)} className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400"><option value="materials_ready">物料已齐备</option><option value="in_production">生产中</option><option value="quality_check">质量检验</option><option value="ready_to_ship">待发运</option><option value="delayed">延期</option><option value="blocked">受阻</option></select></label>
              <label><span className="text-xs font-medium text-slate-700">预计可发运时间（可选）</span><input type="datetime-local" value={productionExpectedReadyAt} onChange={(event) => setProductionExpectedReadyAt(event.target.value)} className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
              <label className="sm:col-span-2"><span className="text-xs font-medium text-slate-700">供应商说明{["delayed","blocked"].includes(productionProgressStatus) ? <span className="text-red-500"> *</span> : null}</span><textarea value={productionNote} onChange={(event) => setProductionNote(event.target.value)} maxLength={500} placeholder="记录延期原因、缺料、质检问题或供应商说明" className="mt-2 min-h-20 w-full resize-none rounded-xl border border-slate-200 bg-white p-3 text-sm outline-none focus:border-blue-400" /></label>
              <label className="sm:col-span-2"><span className="text-xs font-medium text-slate-700">原始核验依据 <span className="text-red-500">*</span></span><input value={verificationReference} onChange={(event) => setVerificationReference(event.target.value)} maxLength={300} placeholder="邮件 Message-ID、附件 ID 或会议纪要地址" className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
              <label className="sm:col-span-2"><span className="text-xs font-medium text-slate-700">核验原因 <span className="text-red-500">*</span></span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="说明核对了哪些原始事实，以及为什么可信" className="mt-2 min-h-20 w-full resize-none rounded-xl border border-slate-200 bg-white p-3 text-sm outline-none focus:border-blue-400" /></label>
            </div>
            <div><div className="text-xs font-semibold text-slate-700">行级完成事实</div><div className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="hidden grid-cols-[minmax(0,1fr)_96px_86px] gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2 text-[10px] font-semibold text-slate-500 sm:grid"><span>PO 行</span><span>完成数量</span><span>完成度</span></div>{confirming.productionProgressForm.lines.map((line) => <div key={line.poLineId} className="grid gap-2 border-b border-slate-100 px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_96px_86px] sm:items-center"><div className="min-w-0"><div className="truncate text-xs font-medium text-slate-800"><span data-preserve-language={"labelIsFallback" in line && line.labelIsFallback ? undefined : true}>{line.label}</span></div><div className="mt-1 text-[10px] text-slate-400">有效订购 {line.effectiveQty} <span data-preserve-language>{line.uom}</span></div></div><input type="number" min="0" max={line.effectiveQty} step="any" aria-label={`${line.label} 完成数量`} value={productionQuantities[line.poLineId] ?? ""} onChange={(event) => setProductionQuantities((current) => ({ ...current, [line.poLineId]: event.target.value }))} className="h-9 w-full rounded-lg border border-slate-200 px-2 text-right text-sm font-semibold outline-none focus:border-blue-400" /><div className="relative"><input type="number" min="0" max="100" step="1" aria-label={`${line.label} 完成度`} value={productionPercentages[line.poLineId] ?? ""} onChange={(event) => setProductionPercentages((current) => ({ ...current, [line.poLineId]: event.target.value }))} className="h-9 w-full rounded-lg border border-slate-200 px-2 pr-6 text-right text-sm font-semibold outline-none focus:border-blue-400" /><span className="pointer-events-none absolute right-2 top-2.5 text-[10px] text-slate-400">%</span></div></div>)}</div></div>
            <div className="text-[11px] leading-5 text-[#65748a]">这里只保存经人工核验的供应商履约事实，不会自动发信、修改 Odoo 或生成 Shipment。只有全部有效 PO 行均达到待发运，Fulfilment 阶段才会完成。</div>
          </div>}
          {confirming.evidenceForm && <div className="space-y-4 rounded-2xl border border-[#dce5f0] bg-[#f8faff] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#26364f]">{confirming.evidenceForm.kind === "shipment" ? <Truck className="size-4 text-blue-600" /> : <Warehouse className="size-4 text-blue-600" />}{confirming.evidenceForm.kind === "shipment" ? "人工核验供应商发运" : "人工核验仓库 / ERP 收货"}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="sm:col-span-2"><span className="text-xs font-medium text-slate-700">{confirming.evidenceForm.kind === "shipment" ? "ASN / 发运单号" : "GRN / 收货单号"} <span className="text-red-500">*</span></span><input value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} maxLength={120} placeholder={confirming.evidenceForm.kind === "shipment" ? "输入供应商真实发运单号" : "输入仓库或 ERP 真实 GRN 号"} className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
              {confirming.evidenceForm.kind === "shipment" ? <>
                <label><span className="text-xs font-medium text-slate-700">承运商（可选）</span><input value={carrier} onChange={(event) => setCarrier(event.target.value)} maxLength={120} placeholder="例如 DHL、顺丰" className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
                <label><span className="text-xs font-medium text-slate-700">运单号（可选）</span><input value={trackingNumber} onChange={(event) => setTrackingNumber(event.target.value)} maxLength={120} placeholder="输入真实追踪号" className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
                <label className="sm:col-span-2"><span className="text-xs font-medium text-slate-700">预计到货时间 ETA（可选）</span><input type="datetime-local" value={estimatedArrivalAt} onChange={(event) => setEstimatedArrivalAt(event.target.value)} className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /><span className="mt-1 block text-[10px] leading-4 text-slate-400">按当前浏览器时区录入，保存时转换为可审计的 ISO 时间。</span></label>
              </> : <><label><span className="text-xs font-medium text-slate-700">仓库标识 <span className="text-red-500">*</span></span><input value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)} maxLength={120} placeholder="输入 Odoo / WMS 仓库 ID" className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label><label><span className="text-xs font-medium text-slate-700">关联发运单（可选）</span><select value={shipmentId} onChange={(event) => setShipmentId(event.target.value)} className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400"><option value="">不指定</option>{confirming.evidenceForm.shipments?.map((shipment) => <option key={shipment.id} value={shipment.id}>{shipment.reference}</option>)}</select></label></>}
              <label className="sm:col-span-2"><span className="text-xs font-medium text-slate-700">原始核验依据 <span className="text-red-500">*</span></span><input value={verificationReference} onChange={(event) => setVerificationReference(event.target.value)} maxLength={300} placeholder="例如：邮件 Message-ID、附件编号、Odoo Receipt URL 或仓库签收凭证号" className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
              <label className="sm:col-span-2"><span className="text-xs font-medium text-slate-700">核验原因 <span className="text-red-500">*</span></span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="说明你核对了哪些原始事实，以及为什么可以推进 PO 阶段" className="mt-2 min-h-20 w-full resize-none rounded-xl border border-slate-200 bg-white p-3 text-sm outline-none focus:border-blue-400" /></label>
            </div>
            <div><div className="text-xs font-semibold text-slate-700">本次行级数量</div><div className="mt-2 overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="hidden grid-cols-[minmax(0,1fr)_100px_96px] gap-3 border-b border-slate-100 bg-slate-50 px-3 py-2 text-[10px] font-semibold text-slate-500 sm:grid"><span>PO 行</span><span>当前累计</span><span>本次数量</span></div>{confirming.evidenceForm.lines.map((line) => <div key={line.poLineId} className="grid gap-2 border-b border-slate-100 px-3 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_100px_96px] sm:items-center"><div className="min-w-0"><div className="truncate text-xs font-medium text-slate-800"><span data-preserve-language={"labelIsFallback" in line && line.labelIsFallback ? undefined : true}>{line.label}</span></div><div className="mt-1 text-[10px] text-slate-400">订购 {line.orderedQty} <span data-preserve-language>{line.uom}</span> · 本次上限 {line.maxQuantity}</div></div><div className="text-[11px] text-slate-500">已发 {line.shippedQty}<br />已收 {line.receivedQty}</div><input type="number" min="0" max={line.maxQuantity} step="any" aria-label={`${line.label} 本次数量`} value={evidenceQuantities[line.poLineId] ?? ""} onChange={(event) => setEvidenceQuantities((current) => ({ ...current, [line.poLineId]: event.target.value }))} className="h-9 w-full rounded-lg border border-slate-200 px-2 text-right text-sm font-semibold outline-none focus:border-blue-400" /></div>)}</div></div>
            <div className="text-[11px] leading-5 text-[#65748a]">此入口只保存“人工核验事实”，不会冒充供应商、仓库或 ERP 连接器回执；页面也不会据此发送邮件或修改 Odoo。最终进口 GRN 仍受单证安全门禁约束。</div>
          </div>}
          {confirming.transportEventForm && <div className="space-y-4 rounded-2xl border border-[#dce5f0] bg-[#f8faff] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#26364f]"><Truck className="size-4 text-blue-600" />人工核验运输 / 清关节点</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label><span className="text-xs font-medium text-slate-700">关联 Shipment <span className="text-red-500">*</span></span><select value={shipmentId} onChange={(event) => setShipmentId(event.target.value)} className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400">{confirming.transportEventForm.shipments.map((shipment) => <option key={shipment.id} value={shipment.id}>{shipment.reference}</option>)}</select></label>
              <label><span className="text-xs font-medium text-slate-700">节点类型 <span className="text-red-500">*</span></span><select value={transportEventCode} onChange={(event) => setTransportEventCode(event.target.value)} className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400">{([['picked_up','已揽收'],['departed_origin','已离开发运地'],['arrived_port','已抵达口岸'],['customs_submitted','已提交清关'],['customs_cleared','已完成清关'],['customs_held','清关受阻'],['out_for_delivery','派送中'],['delivered','承运商已送达'],['exception','运输异常']] as const).filter(([code]) => confirming.transportEventForm?.route === 'import' || !code.startsWith('customs_')).map(([code,label]) => <option key={code} value={code}>{label}</option>)}</select></label>
              <label><span className="text-xs font-medium text-slate-700">实际发生时间 <span className="text-red-500">*</span></span><input type="datetime-local" value={transportEventOccurredAt} onChange={(event) => setTransportEventOccurredAt(event.target.value)} className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
              <label><span className="text-xs font-medium text-slate-700">节点证据编号 <span className="text-red-500">*</span></span><input value={transportEventReference} onChange={(event) => setTransportEventReference(event.target.value)} maxLength={120} placeholder="例如 TRACK-EVT-20260828-01" className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
              <label><span className="text-xs font-medium text-slate-700">位置（可选）</span><input value={transportLocation} onChange={(event) => setTransportLocation(event.target.value)} maxLength={160} placeholder="港口、机场、城市或仓库" className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
              <label><span className="text-xs font-medium text-slate-700">承运商参考号（可选）</span><input value={carrierReference} onChange={(event) => setCarrierReference(event.target.value)} maxLength={160} placeholder="承运商事件 ID / 状态码" className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
              <label className="sm:col-span-2"><span className="text-xs font-medium text-slate-700">更新后的 ETA（可选）</span><input type="datetime-local" value={estimatedArrivalAt} onChange={(event) => setEstimatedArrivalAt(event.target.value)} className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
              <label className="sm:col-span-2"><span className="text-xs font-medium text-slate-700">原始核验依据 <span className="text-red-500">*</span></span><input value={verificationReference} onChange={(event) => setVerificationReference(event.target.value)} maxLength={300} placeholder="承运商页面、邮件 Message-ID、提单或报关单编号" className="mt-2 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400" /></label>
              <label className="sm:col-span-2"><span className="text-xs font-medium text-slate-700">核验原因 <span className="text-red-500">*</span></span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="说明核对了什么事实以及为什么可信" className="mt-2 min-h-20 w-full resize-none rounded-xl border border-slate-200 bg-white p-3 text-sm outline-none focus:border-blue-400" /></label>
            </div>
            <div className="text-[11px] leading-5 text-[#65748a]">清关节点只对有明确进口路线证据的 PO 开放。承运商“已送达”只是物流节点，最终完成仍必须由仓库 / ERP GRN 证明。</div>
          </div>}
          {confirming.shortfallLines?.length ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs leading-5 text-red-800"><div className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" />这不是部分发货：批准后剩余量将永久关闭</div><p className="mt-2">如仍需供应商后续交付，请取消审批，继续沟通或选择“要求分批交付”。</p><div className="mt-3 overflow-hidden rounded-lg border border-red-100 bg-white"><div className="grid grid-cols-[minmax(0,1fr)_72px_72px_72px] gap-2 bg-red-50 px-3 py-2 text-[10px] font-semibold"><span>PO 行</span><span>订购</span><span>确认</span><span>关闭</span></div>{confirming.shortfallLines.map((line) => <div key={line.poLineId} className="grid grid-cols-[minmax(0,1fr)_72px_72px_72px] gap-2 border-t border-red-100 px-3 py-2 text-[10px]"><span className="truncate font-semibold"><span data-preserve-language={"labelIsFallback" in line && line.labelIsFallback ? undefined : true}>{line.label}</span></span><span>{line.orderedQty} <span data-preserve-language>{line.uom}</span></span><span>{line.confirmedQty} <span data-preserve-language>{line.uom}</span></span><span>{line.remainderQty} <span data-preserve-language>{line.uom}</span></span></div>)}</div></div> : null}
          <div className={cn("rounded-xl border p-3", confirmingBusinessFact ? "border-blue-200 bg-blue-50" : "border-amber-200 bg-amber-50")}><div className={cn("text-xs font-semibold", confirmingBusinessFact ? "text-blue-900" : "text-amber-900")}>确认后将按顺序执行</div><ol className={cn("mt-2 space-y-1.5 text-xs leading-5", confirmingBusinessFact ? "text-blue-800" : "text-amber-800")}>{confirming.sideEffects.map((effect, index) => <li key={effect}>{index + 1}. {effect}</li>)}</ol></div>
          {confirming.reasonEditable && <label className="block"><span className="text-xs font-medium text-slate-700">{confirming.requiresReason ? "短交剩余量关闭原因" : "决策原因"} {confirming.requiresReason ? <span className="text-red-500">*</span> : <span className="text-slate-400">（可选）</span>}</span><textarea required={confirming.requiresReason} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder={confirming.requiresReason ? "说明为什么接受短交并关闭剩余量" : "记录为什么批准或拒绝"} className="mt-2 min-h-20 w-full resize-none rounded-xl border border-slate-200 p-3 text-sm outline-none focus:border-[#78ad99]" /></label>}
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-500">请求编号：<span className="font-mono">{confirming.idempotencyKey}</span><br />{confirming.runtime ? "运行时审批不声明幂等；如状态冲突，请先刷新。结果不明时也请先刷新，再决定是否重试。" : "同一请求编号可安全重试，系统会避免重复发送、重复发运、重复收货或重复回写。"}</div>
          {feedback?.tone === "error" && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">{feedback.text}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-4"><Button variant="outline" disabled={submitting} onClick={() => setConfirming(null)}>取消</Button><Button disabled={submitting} onClick={() => void submitAction()}>{submitting ? <Loader2 className="size-4 animate-spin" /> : confirming.tone === "danger" ? <XCircle className="size-4" /> : <Check className="size-4" />}{submitting ? "等待后端确认…" : confirming.shortfallLines?.length ? confirming.label : confirmingBusinessFact ? "确认事实并保存" : "确认并继续"}</Button></div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>}
  </div>;
}
