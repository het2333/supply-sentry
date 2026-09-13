"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import {
  Loader2,
  Plus,
  RefreshCw,
  Send,
  X,
  BarChart3,
  UserPlus,
  Search,
  FileText,
  Clock3,
  Target,
  CheckCircle2,
  UsersRound,
  Inbox,
  ClipboardList,
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

interface Attachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  url?: string;
  sha256?: string;
  version?: number;
  requisitionLineId?: string;
  extractionStatus?: string;
  securityStatus?: string;
  processingStatus?: string;
}
interface Requisition {
  id: string;
  title?: string;
  currency?: string;
  attachments?: Attachment[];
  attachmentCount?: number;
  lines?: Array<{
    id?: string;
    itemCode?: string;
    itemName: string;
    quantity: number | string;
    unit: string;
    targetDate?: string;
    technicalRequirements?: string;
  }>;
}
interface Supplier {
  id: string;
  name?: string;
  email?: string;
  status?: string;
  currency?: string;
}
interface Rfq {
  id: string;
  externalId?: string;
  title?: string;
  status?: string;
  version?: number;
  deadline?: string;
  currency?: string;
  requisitionId?: string;
  supplierIds?: string[];
  attachmentIds?: string[];
  attachments?: Attachment[];
  supplierCount?: number;
  quoteCount?: number;
  quotedSupplierCount?: number;
  pendingSupplierCount?: number;
  lines?: Requisition["lines"];
  comparisonSnapshot?: { id?: string; lineComparisons?: LineComparison[] };
  createdAt?: string;
}
interface QuoteLine {
  rfqLineId?: string;
  itemName?: string;
  unitPrice?: number;
  quotedQuantity?: number;
  uom?: string;
  moq?: number;
  promisedAt?: string;
  leadTimeDays?: number;
  paymentTerms?: string;
  taxStatus?: "included" | "excluded" | "unknown";
}
interface Quote {
  id?: string;
  supplierId?: string;
  supplierName?: string;
  currency?: string;
  lines?: QuoteLine[];
  status?: string;
  validUntil?: string;
  receivedAt?: string;
}
interface ComparedQuote {
  quoteId?: string;
  quoteLineId?: string;
  supplierId: string;
  supplierName?: string;
  rank: number | null;
  totalCost: number | null;
  unitPriceUntaxed?: number | null;
  taxStatus?: "included" | "excluded" | "unknown";
  taxReviewRequired?: boolean;
  leadTimeDays: number;
  paymentTerms?: string;
  performanceScore?: number;
  eligibility: string;
  reason: string;
  scores?: { total?: number };
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="rounded-lg bg-slate-50 p-2.5">{icon}</div>
      <div>
        <div className="text-xs text-slate-500">{label}</div>
        <div className="mt-0.5 text-xl font-semibold text-slate-900">
          {value}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  const labels: Record<string, string> = {
    draft: "草稿",
    sent: "沟通已记录",
    awaiting_quotes: "报价收集中",
    partial_quotes: "部分报价",
    quotes_complete: "报价齐全",
    compared: "待补充报价",
    pending_award: "待定标",
    awarded: "已定标",
    closed: "已完成",
    completed: "已完成",
  };
  const value = status ?? "draft";
  const tone = ["pending_award", "compared"].includes(value)
    ? "bg-amber-50 text-amber-700"
    : ["awarded", "closed", "completed"].includes(value)
      ? "bg-emerald-50 text-emerald-700"
      : value === "draft"
        ? "bg-slate-100 text-slate-600"
        : "bg-blue-50 text-blue-700";
  return (
    <span
      className={`whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-medium ${tone}`}
    >
      {labels[value] ?? value}
    </span>
  );
}

function RfqProgress({ status }: { status?: string }) {
  const current =
    status === "draft"
      ? 0
      : [
            "sent",
            "awaiting_quotes",
            "partial_quotes",
            "quotes_complete",
          ].includes(status ?? "")
        ? 1
        : status === "compared"
          ? 2
          : status === "pending_award"
            ? 3
            : ["awarded", "closed", "completed"].includes(status ?? "")
              ? 4
              : 0;
  const steps = ["草稿", "报价收集", "比价", "待定标", "已定标"];
  return (
    <div className="mt-5 grid grid-cols-5">
      {steps.map((step, index) => (
        <div key={step} className="relative text-center">
          <div
            className={`relative z-10 mx-auto flex size-6 items-center justify-center rounded-full border text-[10px] ${index <= current ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-slate-400"}`}
          >
            {index < current ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              index + 1
            )}
          </div>
          {index < 4 && (
            <div
              className={`absolute left-1/2 top-3 h-px w-full ${index < current ? "bg-blue-600" : "bg-slate-200"}`}
            />
          )}
          <div
            className={`mt-1.5 text-[10px] ${index === current ? "font-medium text-blue-700" : "text-slate-400"}`}
          >
            {step}
          </div>
        </div>
      ))}
    </div>
  );
}

function WorkspaceTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-b-2 pb-3 text-xs font-medium ${active ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}
    >
      {children}
    </button>
  );
}

function EmptyQuoteState({ onEntry }: { onEntry: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center">
      <FileText className="mx-auto mb-2 size-7 text-slate-300" />
      <div className="text-sm font-medium text-slate-700">暂无结构化报价</div>
      <p className="mt-1 text-xs text-slate-500">
        供应商报价登记后，会自动展示在此并可用于比价。
      </p>
      <Button className="mt-4" size="sm" onClick={onEntry}>
        <Plus className="size-3.5" />
        录入报价
      </Button>
    </div>
  );
}

function QuoteEntry({
  selected,
  suppliers,
  quoteSupplierId,
  setQuoteSupplierId,
  quoteCurrency,
  setQuoteCurrency,
  quoteValidUntil,
  setQuoteValidUntil,
  quoteLineForm,
  updateQuoteLine,
  minimumDate,
  quoteSaving,
  onCancel,
  onSubmit,
}: {
  selected: Rfq;
  suppliers: Supplier[];
  quoteSupplierId: string;
  setQuoteSupplierId: (value: string) => void;
  quoteCurrency: string;
  setQuoteCurrency: (value: string) => void;
  quoteValidUntil: string;
  setQuoteValidUntil: (value: string) => void;
  quoteLineForm: (lineId: string) => {
    unitPrice: string;
    quotedQuantity: string;
    moq: string;
    promisedAt: string;
    leadTimeDays: string;
    paymentTerms: string;
    taxStatus: "included" | "excluded" | "unknown";
  };
  updateQuoteLine: (
    lineId: string,
    patch: Partial<{
      unitPrice: string;
      quotedQuantity: string;
      moq: string;
      promisedAt: string;
      leadTimeDays: string;
      paymentTerms: string;
      taxStatus: "included" | "excluded" | "unknown";
    }>,
  ) => void;
  minimumDate: string;
  quoteSaving: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <section className="rounded-xl border border-blue-200 bg-blue-50/30 p-3">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-900">
          录入结构化报价
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-slate-500"
        >
          收起
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="text-xs text-slate-600">
          供应商
          <select
            value={quoteSupplierId}
            onChange={(event) => setQuoteSupplierId(event.target.value)}
            className={inputClassName}
          >
            <option value="">选择供应商</option>
            {suppliers.map((supplier) => (
              <option data-preserve-language key={supplier.id} value={supplier.id}>{supplier.name ?? supplier.id}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-600">
          币种
          <select
            value={quoteCurrency}
            onChange={(event) => setQuoteCurrency(event.target.value)}
            className={inputClassName}
          >
            <option>CNY</option>
            <option>USD</option>
            <option>EUR</option>
          </select>
        </label>
        <label className="text-xs text-slate-600">
          有效期
          <input
            type="date"
            min={minimumDate}
            value={quoteValidUntil}
            onChange={(event) => setQuoteValidUntil(event.target.value)}
            className={inputClassName}
          />
        </label>
      </div>
      <div className="mt-3 space-y-2">
        {(selected.lines ?? []).map((line) => {
          const id = line.id ?? "";
          const value = quoteLineForm(id);
          return (
            <div
              key={id || line.itemName}
              className="rounded-lg border border-slate-200 bg-white p-2.5"
            >
              <div className="mb-2 text-xs font-medium text-slate-700">
                {line.itemName} · 需求 {displayNumber(Number(line.quantity))}{" "}
                {line.unit}
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <input
                  aria-label={`${line.itemName} 单价`}
                  placeholder="单价*"
                  value={value.unitPrice}
                  onChange={(event) =>
                    updateQuoteLine(id, { unitPrice: event.target.value })
                  }
                  className="h-8 rounded border border-slate-200 px-2 text-xs"
                />
                <input
                  aria-label={`${line.itemName} 数量`}
                  placeholder="报价数量*"
                  value={value.quotedQuantity}
                  onChange={(event) =>
                    updateQuoteLine(id, { quotedQuantity: event.target.value })
                  }
                  className="h-8 rounded border border-slate-200 px-2 text-xs"
                />
                <input
                  aria-label={`${line.itemName} 交期`}
                  placeholder="交期天数*"
                  value={value.leadTimeDays}
                  onChange={(event) =>
                    updateQuoteLine(id, { leadTimeDays: event.target.value })
                  }
                  className="h-8 rounded border border-slate-200 px-2 text-xs"
                />
                <input
                  aria-label={`${line.itemName} MOQ`}
                  placeholder="MOQ"
                  value={value.moq}
                  onChange={(event) =>
                    updateQuoteLine(id, { moq: event.target.value })
                  }
                  className="h-8 rounded border border-slate-200 px-2 text-xs"
                />
                <input
                  aria-label={`${line.itemName} 付款条款`}
                  placeholder="付款条款*"
                  value={value.paymentTerms}
                  onChange={(event) =>
                    updateQuoteLine(id, { paymentTerms: event.target.value })
                  }
                  className="h-8 rounded border border-slate-200 px-2 text-xs"
                />
                <select
                  aria-label={`${line.itemName} 税务口径`}
                  value={value.taxStatus}
                  onChange={(event) =>
                    updateQuoteLine(id, {
                      taxStatus: event.target.value as
                        | "included"
                        | "excluded"
                        | "unknown",
                    })
                  }
                  className="h-8 rounded border border-slate-200 px-2 text-xs"
                >
                  <option value="unknown">税务未说明</option>
                  <option value="included">含税</option>
                  <option value="excluded">未税</option>
                </select>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button
          size="sm"
          disabled={quoteSaving || !quoteSupplierId || !quoteValidUntil}
          onClick={onSubmit}
        >
          {quoteSaving ? "提交中…" : "登记报价"}
        </Button>
      </div>
    </section>
  );
}

function ComparisonAndAward({
  comparison,
  selected,
  awardSelections,
  setAwardSelections,
  awardReason,
  setAwardReason,
  awardSaving,
  awardError,
  awardConfirming,
  setAwardConfirming,
  allAwarded,
  hasAwardCandidates,
  onSubmit,
  awardSuccess,
  purchaseOrderTotal,
}: {
  comparison: ComparisonReport;
  selected: Rfq;
  awardSelections: Record<string, string>;
  setAwardSelections: Dispatch<SetStateAction<Record<string, string>>>;
  awardReason: string;
  setAwardReason: (value: string) => void;
  awardSaving: boolean;
  awardError: string | null;
  awardConfirming: boolean;
  setAwardConfirming: (value: boolean) => void;
  allAwarded: boolean;
  hasAwardCandidates: boolean;
  onSubmit: () => void;
  awardSuccess: AwardApiResponse | null;
  purchaseOrderTotal: (po: DraftPurchaseOrder) => number | undefined;
}) {
  const allQuotes = comparison.lineComparisons.flatMap(
    (line) => line.quotes ?? [],
  );
  const recommendation = allQuotes.find(
    (quote) =>
      quote.supplierId === comparison.lineComparisons[0]?.recommendedSupplierId,
  );
  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[510px] text-left text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2.5">供应商</th>
              <th className="px-3 py-2.5">总成本</th>
              <th className="px-3 py-2.5">交期</th>
              <th className="px-3 py-2.5">付款条件</th>
              <th className="px-3 py-2.5">状态</th>
            </tr>
          </thead>
          <tbody>
            {allQuotes.map((quote) => (
              <tr
                key={quote.quoteLineId ?? quote.supplierId}
                className="border-t border-slate-100"
              >
                <td className="px-3 py-3 font-medium">
                  <span data-preserve-language>{quote.supplierName ?? quote.supplierId}</span>
                </td>
                <td className="px-3 py-3">
                  {displayNumber(quote.totalCost)}{" "}
                  {comparison.lineComparisons[0]?.comparisonCurrency ??
                    selected.currency}
                </td>
                <td className="px-3 py-3 text-emerald-700">
                  {displayNumber(quote.leadTimeDays, 0)} 天
                </td>
                <td className="px-3 py-3"><span data-preserve-language>{quote.paymentTerms ?? "—"}</span></td>
                <td className="px-3 py-3">
                  <span
                    className={
                      quote.eligibility === "eligible"
                        ? "text-emerald-700"
                        : "text-amber-700"
                    }
                  >
                    <span data-preserve-language={ELIGIBILITY_LABEL[quote.eligibility] ? undefined : true}>{ELIGIBILITY_LABEL[quote.eligibility] ?? quote.eligibility}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {recommendation && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
            <CheckCircle2 className="size-4" />
            AI 推荐：<span data-preserve-language>{recommendation.supplierName ?? recommendation.supplierId}</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-emerald-900">
            {comparison.lineComparisons[0]?.recommendationReason ??
              recommendation.reason}
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded bg-white px-2 py-1 text-emerald-700">
              交期 {displayNumber(recommendation.leadTimeDays, 0)} 天
            </span>
            <span className="rounded bg-white px-2 py-1 text-emerald-700">
              综合分 {displayNumber(recommendation.scores?.total)}
            </span>
          </div>
        </div>
      )}
      {!hasAwardCandidates ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          至少一条询价行没有可定标的报价。请补齐报价信息后重新比价。
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 p-3">
          <div className="text-sm font-semibold text-slate-900">人工定标</div>
          <p className="mt-1 text-xs text-slate-500">
            选择每一条询价行的合格报价；AI 不会自动定标。
          </p>
          {comparison.lineComparisons.map((line) => (
            <div key={line.rfqLineId} className="mt-3">
              <div className="mb-1.5 text-xs font-medium text-slate-700">
                {(selected.lines ?? []).find(
                  (item) => item.id === line.rfqLineId,
                )?.itemName ?? line.rfqLineId}
              </div>
              {(line.quotes ?? [])
                .filter((quote) => quote.eligibility === "eligible")
                .map((quote) => (
                  <label
                    key={quote.quoteLineId ?? quote.supplierId}
                    className="mb-1 flex cursor-pointer items-center gap-2 rounded border border-slate-200 p-2 text-xs"
                  >
                    <input
                      type="radio"
                      name={`award-${line.rfqLineId}`}
                      checked={
                        awardSelections[line.rfqLineId] ===
                        (quote.quoteLineId ?? "")
                      }
                      onChange={() =>
                        setAwardSelections((current) => ({
                          ...current,
                          [line.rfqLineId]: quote.quoteLineId ?? "",
                        }))
                      }
                    />
                    <span className="flex-1">
                      <span data-preserve-language>{quote.supplierName ?? quote.supplierId}</span> ·{" "}
                      {displayNumber(quote.totalCost)} ·{" "}
                      {displayNumber(quote.leadTimeDays, 0)} 天
                    </span>
                    {quote.supplierId === line.recommendedSupplierId && (
                      <span className="text-emerald-700">推荐</span>
                    )}
                  </label>
                ))}
            </div>
          ))}
          <textarea
            aria-label="定标原因"
            value={awardReason}
            onChange={(event) => setAwardReason(event.target.value)}
            placeholder="定标原因（必填）"
            className="mt-3 min-h-16 w-full rounded-lg border border-slate-200 p-2 text-xs"
          />
          {awardError && (
            <div className="mt-2 text-xs text-red-700">{awardError}</div>
          )}
          <div className="mt-3 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAwardConfirming(false)}
            >
              重新比价
            </Button>
            <Button
              size="sm"
              disabled={!allAwarded || !awardReason.trim() || awardSaving}
              onClick={() =>
                awardConfirming ? onSubmit() : setAwardConfirming(true)
              }
            >
              {awardSaving
                ? "定标中…"
                : awardConfirming
                  ? "确认定标并生成 PO 草稿"
                  : "批准 AI 推荐"}
            </Button>
          </div>
          {awardConfirming && (
            <p className="mt-2 text-right text-[11px] text-amber-700">
              确认后会生成真实 PO Draft，不会自动写回 ERP。
            </p>
          )}
        </div>
      )}
      {awardSuccess && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
          定标完成，已生成 {(awardSuccess.purchaseOrders ?? []).length} 个 PO
          Draft；总额{" "}
          {displayNumber(
            (awardSuccess.purchaseOrders ?? []).reduce(
              (sum, po) => sum + (purchaseOrderTotal(po) ?? 0),
              0,
            ),
          )}
          。
        </div>
      )}
    </>
  );
}
interface LineComparison {
  rfqLineId: string;
  lineNumber?: string;
  itemId?: string;
  comparisonCurrency?: string;
  purchaseQuantity?: number;
  quotes?: ComparedQuote[];
  recommendedSupplierId?: string | null;
  recommendationReason?: string;
  ruleVersion?: string;
  rateSnapshotVersion?: string;
}
interface ComparisonReport {
  rfqId: string;
  comparisonSnapshotId?: string;
  rfqVersion?: number;
  rfqStatus?: string;
  lineComparisons: LineComparison[];
}
interface ComparisonApiResponse {
  comparisonSnapshot?: { id?: string; lineComparisons?: LineComparison[] };
  rfq?: Rfq;
  replayed?: boolean;
  // Kept for compatibility with older workbench responses during rolling upgrades.
  rfqId?: string;
  comparisonSnapshotId?: string;
  rfqVersion?: number;
  rfqStatus?: string;
  lineComparisons?: LineComparison[];
}
interface DraftPurchaseOrder {
  id?: string;
  supplierId?: string;
  supplierName?: string;
  currency?: string;
  total?: number;
  status?: string;
  lines?: Array<{ orderedQuantity?: number; unitPrice?: number }>;
}
interface AwardApiResponse {
  award?: { id?: string };
  purchaseOrders?: DraftPurchaseOrder[];
  rfq?: Rfq;
  replayed?: boolean;
}

const unwrap = (payload: unknown): unknown[] =>
  Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { items?: unknown[] }).items)
      ? (payload as { items: unknown[] }).items
      : [];
const message = (error: unknown) => {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 403) return "当前账号没有执行此采购操作的权限。";
    if (error.status === 409) return error.message;
    if (error.status === 404) return error.message;
  }
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
};
const idKey = () =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `rfq-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ELIGIBILITY_LABEL: Record<string, string> = {
  eligible: "可参与比较",
  expired: "报价已过期",
  quoted_quantity_insufficient: "报价数量不足",
  moq_not_met: "未满足 MOQ",
  tax_review_required: "税务待复核",
};
const TAX_STATUS_LABEL: Record<string, string> = {
  included: "含税",
  excluded: "未税",
  unknown: "税务未说明",
};
const inputClassName =
  "mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100";
const displayNumber = (value?: number | null, maximumFractionDigits = 2) =>
  value === undefined || value === null || !Number.isFinite(value)
    ? "—"
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(value);
type WorkflowStage = "sourcing" | "rfq" | "compare" | "award" | "completed";
const businessRfqNumber = (rfq: Rfq) => {
  const external = rfq.externalId?.trim();
  if (external && !external.startsWith("rfq:")) return external;
  return (
    rfq.title?.match(/RFQ-[A-Z0-9-]+/i)?.[0] ??
    `RFQ-${rfq.id.slice(-8).toUpperCase()}`
  );
};
const hasAwardReadyComparison = (rfq: Rfq) => {
  const lines = rfq.comparisonSnapshot?.lineComparisons ?? [];
  return (
    lines.length > 0 &&
    lines.every((line) => Boolean(line.recommendedSupplierId))
  );
};
const workflowStage = (rfq: Rfq): WorkflowStage => {
  const status = rfq.status ?? "draft";
  if (["awarded", "closed", "completed"].includes(status)) return "completed";
  if (["compared", "pending_award"].includes(status))
    return hasAwardReadyComparison(rfq) ? "award" : "compare";
  if (status === "quotes_complete") return "compare";
  return "rfq";
};
const stageLabel: Record<WorkflowStage, string> = {
  sourcing: "待开始寻源",
  rfq: "询价进行中",
  compare: "待比价/补充",
  award: "待定标",
  completed: "已完成",
};

export function ProcurementRfqs({
  onCreateRequisition,
}: {
  onCreateRequisition?: () => void;
}) {
  const { formatDate: displayDate } = useProcurementLocale();
  const [rfqs, setRfqs] = useState<Rfq[]>([]);
  const [requisitions, setRequisitions] = useState<Requisition[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Rfq | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [supplierForm, setSupplierForm] = useState({
    name: "",
    currency: "CNY",
    contactName: "",
    email: "",
    phone: "",
  });
  const [supplierSaving, setSupplierSaving] = useState(false);
  const [quoteSupplierId, setQuoteSupplierId] = useState("");
  const [quoteCurrency, setQuoteCurrency] = useState("CNY");
  const [quoteValidUntil, setQuoteValidUntil] = useState("");
  const [quoteForm, setQuoteForm] = useState<
    Record<
      string,
      {
        unitPrice: string;
        quotedQuantity: string;
        moq: string;
        promisedAt: string;
        leadTimeDays: string;
        paymentTerms: string;
        taxStatus: "included" | "excluded" | "unknown";
      }
    >
  >({});
  const [quoteSaving, setQuoteSaving] = useState(false);
  const [comparison, setComparison] = useState<ComparisonReport | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [rateInputs, setRateInputs] = useState<Record<string, string>>({});
  const [awardSelections, setAwardSelections] = useState<
    Record<string, string>
  >({});
  const [awardReason, setAwardReason] = useState("");
  const [awardConfirming, setAwardConfirming] = useState(false);
  const [awardSaving, setAwardSaving] = useState(false);
  const [awardError, setAwardError] = useState<string | null>(null);
  const [awardSuccess, setAwardSuccess] = useState<AwardApiResponse | null>(
    null,
  );
  const [rfqQuery, setRfqQuery] = useState("");
  const [rfqFilter, setRfqFilter] = useState<"all" | WorkflowStage>("all");
  const [workspaceTab, setWorkspaceTab] = useState<
    "overview" | "quotes" | "award" | "documents"
  >("overview");
  const [showQuoteEntry, setShowQuoteEntry] = useState(false);
  const createKeyRef = useRef(idKey());
  const syncKeyRef = useRef(idKey());
  const supplierKeyRef = useRef(idKey());
  const quoteKeysRef = useRef(new Map<string, string>());
  const quoteInFlightRef = useRef(false);
  const compareInFlightRef = useRef(false);
  const compareAttemptsRef = useRef(
    new Map<string, { key: string; asOf: string; rateVersion: string }>(),
  );
  const awardInFlightRef = useRef(false);
  const awardKeysRef = useRef(new Map<string, string>());
  const syncInFlightRef = useRef(false);
  const syncAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const [form, setForm] = useState({
    requisitionId: "",
    title: "",
    deadline: "",
    currency: "CNY",
    supplierIds: [] as string[],
    attachmentIds: [] as string[],
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rfqPayload, requisitionPayload, supplierPayload] =
        await Promise.all([
          apiRequest<unknown>("/api/procurement/rfqs"),
          apiRequest<unknown>("/api/procurement/requisitions"),
          apiRequest<unknown>("/api/procurement/suppliers"),
        ]);
      const next = unwrap(rfqPayload) as Rfq[];
      setRfqs(next);
      setRequisitions(unwrap(requisitionPayload) as Requisition[]);
      setSuppliers(unwrap(supplierPayload) as Supplier[]);
      setSelectedId((current) =>
        current && !next.some((rfq) => rfq.id === current) ? null : current,
      );
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () => () => {
      mountedRef.current = false;
      syncAbortRef.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      setQuotes([]);
      setComparison(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setSelected(null);
    setDetailLoading(true);
    setDetailError(null);
    Promise.all([
      apiRequest<Rfq>(
        `/api/procurement/rfqs/${encodeURIComponent(selectedId)}`,
        { signal: controller.signal },
      ),
      apiRequest<unknown>(
        `/api/procurement/rfqs/${encodeURIComponent(selectedId)}/quotes`,
        { signal: controller.signal },
      ),
    ])
      .then(([rfq, quotePayload]) => {
        if (!cancelled) {
          setSelected(rfq);
          setQuotes(unwrap(quotePayload) as Quote[]);
          setQuoteCurrency(rfq.currency ?? "CNY");
          setQuoteValidUntil("");
          setQuoteSupplierId("");
          setQuoteForm({});
          setRateInputs({});
          setComparison(
            rfq.comparisonSnapshot?.id && rfq.comparisonSnapshot.lineComparisons
              ? {
                  rfqId: rfq.id,
                  comparisonSnapshotId: rfq.comparisonSnapshot.id,
                  rfqVersion: rfq.version,
                  rfqStatus: rfq.status,
                  lineComparisons: rfq.comparisonSnapshot.lineComparisons,
                }
              : null,
          );
          setAwardSelections({});
          setAwardReason("");
          setAwardConfirming(false);
          setAwardError(null);
          setAwardSuccess(null);
        }
      })
      .catch((requestError) => {
        if (!cancelled && !controller.signal.aborted)
          setDetailError(message(requestError));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedId]);

  const registerSupplier = async () => {
    if (
      !supplierForm.name.trim() ||
      !supplierForm.contactName.trim() ||
      !EMAIL_PATTERN.test(supplierForm.email.trim()) ||
      supplierSaving
    )
      return;
    setSupplierSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await apiRequest<{
        supplier: Supplier;
        version: number;
        replayed: boolean;
      }>("/api/procurement/suppliers", {
        method: "POST",
        body: {
          idempotencyKey: supplierKeyRef.current,
          name: supplierForm.name.trim(),
          currency: supplierForm.currency,
          primaryContact: {
            name: supplierForm.contactName.trim(),
            email: supplierForm.email.trim(),
            ...(supplierForm.phone.trim()
              ? { phone: supplierForm.phone.trim() }
              : {}),
          },
        },
      });
      supplierKeyRef.current = idKey();
      setSupplierForm({
        name: "",
        currency: "CNY",
        contactName: "",
        email: "",
        phone: "",
      });
      setShowSupplierForm(false);
      setSuccess("已有供应商档案已登记（不代表准入）。");
      await load();
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setSupplierSaving(false);
    }
  };

  const quoteLineForm = (lineId: string) =>
    quoteForm[lineId] ?? {
      unitPrice: "",
      quotedQuantity: "",
      moq: "",
      promisedAt: "",
      leadTimeDays: "",
      paymentTerms: "",
      taxStatus: "unknown" as const,
    };
  const updateQuoteLine = (
    lineId: string,
    patch: Partial<ReturnType<typeof quoteLineForm>>,
  ) =>
    setQuoteForm((current) => ({
      ...current,
      [lineId]: { ...quoteLineForm(lineId), ...patch },
    }));
  const enterQuote = async () => {
    if (
      !selected ||
      !quoteSupplierId ||
      quoteSaving ||
      quoteInFlightRef.current
    )
      return;
    const rfqLines = selected.lines ?? [];
    if (
      rfqLines.length === 0 ||
      rfqLines.some((line) => !line.id || !line.unit)
    ) {
      setDetailError("RFQ 行数据不完整，无法安全关联报价。");
      return;
    }
    if (!/^[A-Z]{3}$/.test(quoteCurrency.toUpperCase())) {
      setDetailError("请选择有效的三位报价币种。");
      return;
    }
    if (!quoteValidUntil) {
      setDetailError("请填写报价有效期。");
      return;
    }
    const validUntil = new Date(`${quoteValidUntil}T23:59:59.999Z`);
    if (
      !Number.isFinite(validUntil.getTime()) ||
      validUntil.getTime() < Date.now()
    ) {
      setDetailError("报价有效期不能早于当前时间。");
      return;
    }
    const lines = rfqLines.map((line) => {
      const value = quoteLineForm(line.id!);
      return {
        rfqLineId: line.id!,
        uom: line.unit,
        unitPrice: Number(value.unitPrice),
        quotedQuantity: Number(value.quotedQuantity),
        moq: value.moq.trim() ? Number(value.moq) : undefined,
        promisedAt: value.promisedAt.trim() || undefined,
        leadTimeDays: Number(value.leadTimeDays),
        paymentTerms: value.paymentTerms.trim(),
        taxStatus: value.taxStatus,
        raw: value,
      };
    });
    const invalid = lines.some(
      (line) =>
        !line.raw.unitPrice.trim() ||
        !Number.isFinite(line.unitPrice) ||
        line.unitPrice < 0 ||
        !line.raw.quotedQuantity.trim() ||
        !Number.isFinite(line.quotedQuantity) ||
        line.quotedQuantity <= 0 ||
        !line.raw.leadTimeDays.trim() ||
        !Number.isFinite(line.leadTimeDays) ||
        line.leadTimeDays < 0 ||
        !line.paymentTerms ||
        (line.moq !== undefined &&
          (!Number.isFinite(line.moq) || line.moq <= 0)) ||
        (line.promisedAt !== undefined &&
          !Number.isFinite(Date.parse(`${line.promisedAt}T00:00:00+08:00`))),
    );
    if (invalid) {
      setDetailError(
        "请完整填写每行报价：单价和交期不能为负，数量和 MOQ 必须大于 0。",
      );
      return;
    }
    const scope = `${selected.id}:${quoteSupplierId}`;
    let key = quoteKeysRef.current.get(scope);
    if (!key) {
      key = idKey();
      quoteKeysRef.current.set(scope, key);
    }
    quoteInFlightRef.current = true;
    setQuoteSaving(true);
    setDetailError(null);
    setSuccess(null);
    try {
      const created = await apiRequest<Quote>(
        `/api/procurement/rfqs/${encodeURIComponent(selected.id)}/quotes`,
        {
          method: "POST",
          body: {
            idempotencyKey: key,
            supplierId: quoteSupplierId,
            receivedAt: new Date().toISOString(),
            validUntil: validUntil.toISOString(),
            currency: quoteCurrency.toUpperCase(),
            lines: lines.map((line) => ({
              rfqLineId: line.rfqLineId,
              unitPrice: line.unitPrice,
              priceBasisQuantity: 1,
              quotedQuantity: line.quotedQuantity,
              uom: line.uom,
              ...(line.taxStatus === "unknown"
                ? {}
                : { taxIncluded: line.taxStatus === "included" }),
              ...(line.promisedAt
                ? {
                    promisedAt: new Date(
                      `${line.promisedAt}T00:00:00+08:00`,
                    ).toISOString(),
                  }
                : {}),
              leadTimeDays: line.leadTimeDays,
              paymentTerms: line.paymentTerms,
              ...(line.moq === undefined ? {} : { moq: line.moq }),
            })),
          },
        },
      );
      quoteKeysRef.current.delete(scope);
      setQuotes((current) => [
        ...current.filter((quote) => quote.id !== created.id),
        created,
      ]);
      setSuccess("结构化报价已登记。");
      setQuoteForm({});
      setQuoteSupplierId("");
      setQuoteValidUntil("");
      setComparison(null);
      try {
        await reloadSelected();
      } catch {
        setDetailError(
          "报价已登记，但最新列表刷新失败；请手动刷新，不要重复提交。",
        );
      }
    } catch (requestError) {
      setDetailError(message(requestError));
    } finally {
      quoteInFlightRef.current = false;
      setQuoteSaving(false);
    }
  };

  const reloadSelected = async () => {
    if (!selectedId || !mountedRef.current) return;
    const [rfq, quotePayload] = await Promise.all([
      apiRequest<Rfq>(
        `/api/procurement/rfqs/${encodeURIComponent(selectedId)}`,
      ),
      apiRequest<unknown>(
        `/api/procurement/rfqs/${encodeURIComponent(selectedId)}/quotes`,
      ),
    ]);
    if (mountedRef.current) {
      setSelected(rfq);
      setQuotes(unwrap(quotePayload) as Quote[]);
      setComparison(
        rfq.comparisonSnapshot?.id && rfq.comparisonSnapshot.lineComparisons
          ? {
              rfqId: rfq.id,
              comparisonSnapshotId: rfq.comparisonSnapshot.id,
              rfqVersion: rfq.version,
              rfqStatus: rfq.status,
              lineComparisons: rfq.comparisonSnapshot.lineComparisons,
            }
          : null,
      );
    }
  };

  const compare = async () => {
    if (
      !selected ||
      compareLoading ||
      compareInFlightRef.current ||
      quotes.length === 0
    )
      return;
    const target = (selected.currency ?? "CNY").toUpperCase();
    const currencies = [
      ...new Set(
        quotes.map((quote) => (quote.currency ?? target).toUpperCase()),
      ),
    ];
    const invalidRates = currencies.filter(
      (currency) =>
        currency !== target &&
        (!Number.isFinite(Number(rateInputs[`${currency}/${target}`])) ||
          Number(rateInputs[`${currency}/${target}`]) <= 0),
    );
    if (invalidRates.length) {
      setDetailError(
        `请填写大于 0 的有效汇率：${invalidRates.map((currency) => `${currency}/${target}`).join("、")}。`,
      );
      return;
    }
    compareInFlightRef.current = true;
    setCompareLoading(true);
    setDetailError(null);
    try {
      const rates: Record<string, number> = {};
      currencies.forEach((currency) => {
        rates[`${currency}/${target}`] =
          currency === target ? 1 : Number(rateInputs[`${currency}/${target}`]);
      });
      const scope = JSON.stringify([
        selected.id,
        selected.version,
        target,
        Object.entries(rates).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ]);
      let attempt = compareAttemptsRef.current.get(scope);
      if (!attempt) {
        const key = idKey();
        attempt = {
          key,
          asOf: new Date().toISOString(),
          rateVersion: `manual-${key}`,
        };
        compareAttemptsRef.current.set(scope, attempt);
      }
      const response = await apiRequest<ComparisonApiResponse>(
        `/api/procurement/rfqs/${encodeURIComponent(selected.id)}/compare`,
        {
          method: "POST",
          body: {
            idempotencyKey: attempt.key,
            expectedRfqVersion: selected.version,
            asOf: attempt.asOf,
            comparisonCurrency: target,
            rateSnapshot: { version: attempt.rateVersion, rates },
            weights: {
              price: 0.4,
              leadTime: 0.25,
              paymentTerms: 0.1,
              performance: 0.25,
            },
            ruleVersion: "quote-comparison-v1",
          },
        },
      );
      const result: ComparisonReport = {
        rfqId: response.rfq?.id ?? response.rfqId ?? selected.id,
        comparisonSnapshotId:
          response.comparisonSnapshot?.id ?? response.comparisonSnapshotId,
        rfqVersion: response.rfq?.version ?? response.rfqVersion,
        rfqStatus: response.rfq?.status ?? response.rfqStatus,
        lineComparisons:
          response.comparisonSnapshot?.lineComparisons ??
          response.lineComparisons ??
          [],
      };
      if (!result.comparisonSnapshotId || result.lineComparisons.length === 0)
        throw new Error("比价已返回，但缺少可定标的持久化快照。");
      compareAttemptsRef.current.delete(scope);
      setComparison(result);
      const nextRfq = response.rfq;
      setSelected((current) =>
        current
          ? {
              ...current,
              ...nextRfq,
              status: result.rfqStatus ?? "compared",
              version: result.rfqVersion,
              comparisonSnapshot: {
                id: result.comparisonSnapshotId,
                lineComparisons: result.lineComparisons,
              },
            }
          : current,
      );
      setRfqs((current) =>
        current.map((rfq) =>
          rfq.id === selected.id
            ? {
                ...rfq,
                ...nextRfq,
                status: result.rfqStatus ?? "compared",
                version: result.rfqVersion,
              }
            : rfq,
        ),
      );
      setAwardSelections({});
      setAwardReason("");
      setAwardSuccess(null);
    } catch (requestError) {
      setDetailError(message(requestError));
    } finally {
      compareInFlightRef.current = false;
      setCompareLoading(false);
    }
  };

  const awardableLines = comparison?.lineComparisons ?? [];
  const hasAwardCandidates =
    awardableLines.length > 0 &&
    awardableLines.every((line) =>
      line.quotes?.some((quote) => quote.eligibility === "eligible"),
    );
  const allAwarded =
    awardableLines.length > 0 &&
    awardableLines.every((line) => {
      const quoteId = awardSelections[line.rfqLineId];
      return Boolean(
        quoteId &&
          line.quotes?.some(
            (quote) =>
              quote.quoteLineId === quoteId && quote.eligibility === "eligible",
          ),
      );
    });
  const submitAward = async () => {
    if (
      !selected ||
      !comparison ||
      !allAwarded ||
      !awardReason.trim() ||
      awardSaving ||
      awardInFlightRef.current
    )
      return;
    const snapshotId = comparison.comparisonSnapshotId;
    if (!snapshotId) {
      setAwardError("请先生成比价快照，再进行定标。");
      return;
    }
    const scope = `${selected.id}:${snapshotId}`;
    let key = awardKeysRef.current.get(scope);
    if (!key) {
      key = idKey();
      awardKeysRef.current.set(scope, key);
    }
    awardInFlightRef.current = true;
    setAwardSaving(true);
    setAwardError(null);
    setAwardSuccess(null);
    try {
      const result = await apiRequest<AwardApiResponse>(
        `/api/procurement/rfqs/${encodeURIComponent(selected.id)}/award`,
        {
          method: "POST",
          body: {
            idempotencyKey: key,
            expectedRfqVersion: selected.version,
            comparisonSnapshotId: snapshotId,
            reason: awardReason.trim(),
            lines: awardableLines.map((line) => ({
              rfqLineId: line.rfqLineId,
              quoteLineId: awardSelections[line.rfqLineId],
              awardedQuantity: line.purchaseQuantity,
            })),
          },
        },
      );
      awardKeysRef.current.delete(scope);
      setAwardSuccess(result);
      setSelected((current) =>
        current
          ? {
              ...current,
              ...result.rfq,
              status: result.rfq?.status ?? "awarded",
            }
          : current,
      );
      setRfqs((current) =>
        current.map((rfq) =>
          rfq.id === selected.id
            ? { ...rfq, ...result.rfq, status: result.rfq?.status ?? "awarded" }
            : rfq,
        ),
      );
      setAwardConfirming(false);
      try {
        await reloadSelected();
      } catch {
        setDetailError(
          "定标和 PO Draft 已成功落库，但最新详情刷新失败；请手动刷新，不要重复提交。",
        );
      }
    } catch (requestError) {
      setAwardError(message(requestError));
    } finally {
      awardInFlightRef.current = false;
      setAwardSaving(false);
    }
  };

  const selectedReq = useMemo(
    () => requisitions.find((req) => req.id === form.requisitionId),
    [form.requisitionId, requisitions],
  );
  const quoteCandidateSuppliers = useMemo(() => {
    const candidateIds = new Set(selected?.supplierIds ?? []);
    return suppliers.filter((supplier) => candidateIds.has(supplier.id));
  }, [selected?.supplierIds, suppliers]);
  const comparisonTarget = (selected?.currency ?? "CNY").toUpperCase();
  const foreignQuoteCurrencies = useMemo(
    () =>
      [
        ...new Set(
          quotes.map((quote) =>
            (quote.currency ?? comparisonTarget).toUpperCase(),
          ),
        ),
      ].filter((currency) => currency !== comparisonTarget),
    [comparisonTarget, quotes],
  );
  const minimumDate = new Date().toISOString().slice(0, 10);
  const minimumFutureDate = new Date(Date.now() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const toggleSupplier = (id: string) =>
    setForm((current) => ({
      ...current,
      supplierIds: current.supplierIds.includes(id)
        ? current.supplierIds.filter((value) => value !== id)
        : [...current.supplierIds, id],
    }));
  const toggleAttachment = (id: string) =>
    setForm((current) => ({
      ...current,
      attachmentIds: current.attachmentIds.includes(id)
        ? current.attachmentIds.filter((value) => value !== id)
        : [...current.attachmentIds, id],
    }));
  const canSubmit = Boolean(
    form.requisitionId &&
      form.title.trim() &&
      form.deadline &&
      form.currency &&
      form.supplierIds.length &&
      !saving,
  );
  const purchaseOrderTotal = (po: DraftPurchaseOrder) =>
    po.total ??
    po.lines?.reduce(
      (sum, line) => sum + (line.orderedQuantity ?? 0) * (line.unitPrice ?? 0),
      0,
    );
  const create = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await apiRequest<Rfq>("/api/procurement/rfqs", {
        method: "POST",
        body: {
          idempotencyKey: createKeyRef.current,
          requisitionId: form.requisitionId,
          title: form.title.trim(),
          deadline: form.deadline,
          currency: form.currency,
          supplierIds: form.supplierIds,
          attachmentIds: form.attachmentIds,
          lines: selectedReq?.lines ?? [],
        },
      });
      createKeyRef.current = idKey();
      setShowCreate(false);
      setForm({
        requisitionId: "",
        title: "",
        deadline: "",
        currency: "CNY",
        supplierIds: [],
        attachmentIds: [],
      });
      setSuccess(
        `RFQ 草稿已创建，已冻结 ${created.attachments?.length ?? 0} 个经人工选择的附件。本步骤不会发送邮件。`,
      );
      await load();
      if (created.id) setSelectedId(created.id);
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setSaving(false);
    }
  };
  const syncSuppliers = async () => {
    if (syncInFlightRef.current) return;
    syncInFlightRef.current = true;
    const controller = new AbortController();
    syncAbortRef.current = controller;
    setSyncing(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await apiRequest<{
        created: number;
        updated: number;
        unchanged: number;
        issues?: unknown[];
      }>("/api/procurement/suppliers/sync", {
        method: "POST",
        body: { idempotencyKey: syncKeyRef.current },
        signal: controller.signal,
      });
      // The key rotates only after the server confirms success. Failed/timeout requests retry safely with this key.
      syncKeyRef.current = idKey();
      if (!mountedRef.current) return;
      setSuccess(
        `已从 ERP 只读同步现有供应商：新增 ${result.created}，更新 ${result.updated}，未变化 ${result.unchanged}。同步不会做供应商准入或修改 ERP。`,
      );
      await load();
    } catch (requestError) {
      if (!mountedRef.current || controller.signal.aborted) return;
      setError(message(requestError));
    } finally {
      if (syncAbortRef.current === controller) syncAbortRef.current = null;
      syncInFlightRef.current = false;
      if (mountedRef.current) setSyncing(false);
    }
  };

  const filteredRfqs = useMemo(() => {
    const query = rfqQuery.trim().toLowerCase();
    return rfqs.filter((rfq) => {
      const matchesFilter =
        rfqFilter === "all" || workflowStage(rfq) === rfqFilter;
      const supplierNames = (rfq.supplierIds ?? [])
        .map(
          (id) => suppliers.find((supplier) => supplier.id === id)?.name ?? id,
        )
        .join(" ");
      return (
        matchesFilter &&
        (!query ||
          `${businessRfqNumber(rfq)} ${rfq.title ?? ""} ${supplierNames}`
            .toLowerCase()
            .includes(query))
      );
    });
  }, [rfqFilter, rfqQuery, rfqs, suppliers]);
  const linkedRequisitionIds = new Set(
    rfqs.map((rfq) => rfq.requisitionId).filter(Boolean),
  );
  const sourcingRequisitions = requisitions.filter(
    (requisition) => !linkedRequisitionIds.has(requisition.id),
  );
  const filteredSourcing =
    rfqFilter === "all" || rfqFilter === "sourcing"
      ? sourcingRequisitions.filter(
          (requisition) =>
            !rfqQuery.trim() ||
            `${requisition.title ?? ""} ${requisition.id}`
              .toLowerCase()
              .includes(rfqQuery.trim().toLowerCase()),
        )
      : [];
  const pendingReplyCount = rfqs
    .filter((rfq) => workflowStage(rfq) !== "completed")
    .reduce(
      (sum, rfq) =>
        sum +
        (rfq.pendingSupplierCount ??
          Math.max(
            0,
            (rfq.supplierIds?.length ?? 0) - (rfq.quotedSupplierCount ?? 0),
          )),
      0,
    );
  const compareCount = rfqs.filter(
    (rfq) => workflowStage(rfq) === "compare",
  ).length;
  const pendingAwardCount = rfqs.filter(
    (rfq) => workflowStage(rfq) === "award",
  ).length;
  const supplierRows = quoteCandidateSuppliers.map((supplier) => ({
    supplier,
    quote: quotes.find((quote) => quote.supplierId === supplier.id),
  }));
  const timeline = [
    ...(selected?.createdAt
      ? [
          {
            key: "created",
            at: selected.createdAt,
            title: "已创建询价",
            note: "RFQ 草稿已写入业务系统。",
          },
        ]
      : []),
    ...quotes.map((quote) => ({
      key: quote.id ?? `${quote.supplierId}-${quote.receivedAt}`,
      at: quote.receivedAt,
      title: `收到 ${quote.supplierName ?? quote.supplierId ?? "供应商"} 报价`,
      note: "结构化报价已登记，可用于比价。",
    })),
    ...(comparison?.comparisonSnapshotId
      ? [
          {
            key: comparison.comparisonSnapshotId,
            at: undefined,
            title: "已生成持久化比价快照",
            note: "本次比价结果可用于人工定标与审计。",
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-xs font-medium text-blue-700">
            供应商发现 · 询价执行 · 报价决策
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            寻源与询价
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            承接已登记的采购需求，选择候选供应商，回收报价并完成人工定标。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading || syncing}
          >
            <RefreshCw
              className={`size-3.5 ${loading ? "animate-spin" : ""}`}
            />
            刷新
          </Button>
          {onCreateRequisition && (
            <Button variant="outline" size="sm" onClick={onCreateRequisition}>
              <ClipboardList className="size-3.5" />
              登记采购需求
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
            从已登记需求开始
          </Button>
        </div>
      </header>
      {success && (
        <div
          className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
          role="status"
        >
          {success}
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

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          icon={<UsersRound className="size-5 text-blue-600" />}
          label="待开始寻源"
          value={sourcingRequisitions.length}
        />
        <Metric
          icon={<Clock3 className="size-5 text-amber-600" />}
          label="待回收报价"
          value={pendingReplyCount}
        />
        <Metric
          icon={<BarChart3 className="size-5 text-emerald-600" />}
          label="待比价/补充"
          value={compareCount}
        />
        <Metric
          icon={<Target className="size-5 text-violet-600" />}
          label="待定标"
          value={pendingAwardCount}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div>
          <div className="text-sm font-medium text-slate-800">
            候选供应商库：{suppliers.length} 家
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            当前寻源范围为已登记及本地 Odoo 同步的供应商；不会冒充外网自动搜索。
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSupplierForm((value) => !value)}
          >
            <UserPlus className="size-3.5" />
            登记已有供应商
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void syncSuppliers()}
            disabled={syncing}
          >
            <RefreshCw
              className={`size-3.5 ${syncing ? "animate-spin" : ""}`}
            />
            {syncing ? "同步中…" : "从 Odoo 同步"}
          </Button>
        </div>
      </div>

      {showSupplierForm && (
        <Card>
          <CardHeader>
            <CardTitle>登记已有供应商</CardTitle>
            <CardDescription>
              只新增候选供应商档案，不代表准入通过。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="text-xs font-medium text-slate-600">
                供应商名称 *
                <input
                  aria-label="供应商名称"
                  value={supplierForm.name}
                  onChange={(event) =>
                    setSupplierForm({
                      ...supplierForm,
                      name: event.target.value,
                    })
                  }
                  className={inputClassName}
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                币种
                <select
                  aria-label="供应商币种"
                  value={supplierForm.currency}
                  onChange={(event) =>
                    setSupplierForm({
                      ...supplierForm,
                      currency: event.target.value,
                    })
                  }
                  className={inputClassName}
                >
                  <option>CNY</option>
                  <option>USD</option>
                  <option>EUR</option>
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">
                联系人 *
                <input
                  aria-label="联系人"
                  value={supplierForm.contactName}
                  onChange={(event) =>
                    setSupplierForm({
                      ...supplierForm,
                      contactName: event.target.value,
                    })
                  }
                  className={inputClassName}
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                邮箱 *
                <input
                  type="email"
                  aria-label="邮箱"
                  value={supplierForm.email}
                  onChange={(event) =>
                    setSupplierForm({
                      ...supplierForm,
                      email: event.target.value,
                    })
                  }
                  className={inputClassName}
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                电话
                <input
                  aria-label="电话"
                  value={supplierForm.phone}
                  onChange={(event) =>
                    setSupplierForm({
                      ...supplierForm,
                      phone: event.target.value,
                    })
                  }
                  className={inputClassName}
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowSupplierForm(false)}
              >
                取消
              </Button>
              <Button
                disabled={
                  !supplierForm.name.trim() ||
                  !supplierForm.contactName.trim() ||
                  !EMAIL_PATTERN.test(supplierForm.email.trim()) ||
                  supplierSaving
                }
                onClick={() => void registerSupplier()}
              >
                {supplierSaving ? "登记中…" : "登记到候选库"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {showCreate && (
        <Card className="border-blue-200">
          <CardHeader>
            <div className="flex items-start justify-between">
              <div>
                <CardTitle>从已登记采购需求创建询价</CardTitle>
                <CardDescription>
                  选择已保存的需求、附件和现有供应商，仅创建 RFQ
                  草稿；不会发送邮件或回写 Odoo。
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
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs font-medium text-slate-600">
                采购需求
                <select
                  value={form.requisitionId}
                  onChange={(event) => {
                    const req = requisitions.find(
                      (item) => item.id === event.target.value,
                    );
                    setForm((current) => ({
                      ...current,
                      requisitionId: event.target.value,
                      title: current.title || req?.title || "",
                      attachmentIds: [],
                    }));
                  }}
                  className={inputClassName}
                >
                  <option value="">选择一条已登记需求</option>
                  {requisitions.map((req) => (
                    <option key={req.id} value={req.id}>
                      {req.title ?? req.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">
                询价标题
                <input
                  value={form.title}
                  onChange={(event) =>
                    setForm({ ...form, title: event.target.value })
                  }
                  placeholder="例如：气动阀 PV-30 询价"
                  className={inputClassName}
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                报价截止日期
                <input
                  type="date"
                  min={minimumFutureDate}
                  value={form.deadline}
                  onChange={(event) =>
                    setForm({ ...form, deadline: event.target.value })
                  }
                  className={inputClassName}
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                统一比较币种
                <select
                  value={form.currency}
                  onChange={(event) =>
                    setForm({ ...form, currency: event.target.value })
                  }
                  className={inputClassName}
                >
                  <option>CNY</option>
                  <option>USD</option>
                  <option>EUR</option>
                </select>
              </label>
            </div>
            {form.requisitionId && (
              <section className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">
                      选择发给供应商的附件
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      默认不外发任何文件；仅安全扫描通过的文件可勾选，并冻结版本与
                      SHA-256。
                    </div>
                  </div>
                  <Badge tone="neutral">已选 {form.attachmentIds.length}</Badge>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {(selectedReq?.attachments ?? []).length ? (
                    selectedReq!.attachments!.map((attachment) => {
                      const line = selectedReq?.lines?.find(
                        (item) => item.id === attachment.requisitionLineId,
                      );
                      const canSend = attachment.securityStatus === "clean";
                      return (
                        <label
                          key={attachment.id}
                          className={`flex items-start gap-2 rounded-lg border p-2.5 ${canSend ? "cursor-pointer" : "cursor-not-allowed bg-slate-50 opacity-70"} ${form.attachmentIds.includes(attachment.id) ? "border-blue-300 bg-blue-50/50" : "border-slate-200"}`}
                        >
                          <input
                            className="mt-0.5"
                            type="checkbox"
                            disabled={!canSend}
                            checked={form.attachmentIds.includes(attachment.id)}
                            onChange={() => toggleAttachment(attachment.id)}
                          />
                          <span className="min-w-0">
                            <span className="block truncate text-xs font-medium text-slate-700">
                              {attachment.fileName}
                            </span>
                            <span className="mt-1 block text-[10px] text-slate-400">
                              v{attachment.version ?? 1} ·{" "}
                              {line ? `物料：${line.itemName}` : "整张需求"}
                            </span>
                            {!canSend && (
                              <span className="mt-1 block text-[10px] text-amber-700">
                                {attachment.securityStatus === "quarantined"
                                  ? "已隔离，禁止外发"
                                  : "待恶意软件扫描，暂不可外发"}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })
                  ) : (
                    <div className="col-span-full rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center text-xs text-slate-400">
                      该需求暂无附件，RFQ 不会携带文件。
                    </div>
                  )}
                </div>
              </section>
            )}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-slate-800">
                    选择进入询价的现有供应商
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    当前仅从已登记和本地 Odoo 同步的 {suppliers.length}{" "}
                    家供应商中选择，尚不包含外网供应商搜索。
                  </div>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {suppliers.map((supplier) => (
                  <label
                    key={supplier.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border p-3 text-sm transition ${form.supplierIds.includes(supplier.id) ? "border-blue-300 bg-blue-50/50" : "border-slate-200 hover:border-slate-300"}`}
                  >
                    <input
                      type="checkbox"
                      checked={form.supplierIds.includes(supplier.id)}
                      onChange={() => toggleSupplier(supplier.id)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        <span data-preserve-language>{supplier.name ?? supplier.id}</span>
                      </span>
                      <span className="block truncate text-xs text-slate-400">
                        <span data-preserve-language={supplier.email ? true : undefined}>{supplier.email ?? "未登记邮箱"}</span>
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowCreate(false)}>
                取消
              </Button>
              <Button disabled={!canSubmit} onClick={() => void create()}>
                {saving
                  ? "创建中…"
                  : `创建询价草稿${form.supplierIds.length ? `（${form.supplierIds.length} 家）` : ""}`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="border-b border-slate-100 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>采购项目队列</CardTitle>
              <CardDescription>
                一项一行，按寻源、询价、比价和定标阶段推进。
              </CardDescription>
            </div>
            <div className="relative w-full sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate-400" />
              <input
                aria-label="搜索采购项目"
                value={rfqQuery}
                onChange={(event) => setRfqQuery(event.target.value)}
                placeholder="搜索项目、物料或供应商"
                className="h-9 w-full rounded-lg border border-slate-200 pl-9 pr-3 text-xs outline-none focus:border-blue-400"
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {(
              [
                ["all", "全部"],
                ["sourcing", "待寻源"],
                ["rfq", "询价中"],
                ["compare", "待比价"],
                ["award", "待定标"],
                ["completed", "已完成"],
              ] as const
            ).map(([value, text]) => {
              const count =
                value === "all"
                  ? sourcingRequisitions.length + rfqs.length
                  : value === "sourcing"
                    ? sourcingRequisitions.length
                    : rfqs.filter((rfq) => workflowStage(rfq) === value).length;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setRfqFilter(value)}
                  className={`rounded-lg px-3 py-2 text-xs font-medium transition ${rfqFilter === value ? "bg-slate-950 text-white" : "bg-slate-50 text-slate-600 hover:bg-slate-100"}`}
                >
                  {text}
                  <span
                    className={`ml-1.5 ${rfqFilter === value ? "text-white/60" : "text-slate-400"}`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="hidden grid-cols-[minmax(0,1fr)_130px_190px_120px_150px] gap-4 border-b border-slate-100 bg-slate-50/70 px-5 py-2.5 text-[11px] font-medium text-slate-400 lg:grid">
            <span>采购项目</span>
            <span>当前阶段</span>
            <span>供应商进度</span>
            <span>截止时间</span>
            <span className="text-right">下一步</span>
          </div>
          {loading ? (
            <div className="flex justify-center py-20 text-sm text-slate-400">
              <Loader2 className="mr-2 size-4 animate-spin" />
              正在读取真实采购项目…
            </div>
          ) : filteredSourcing.length + filteredRfqs.length === 0 ? (
            <div className="py-16 text-center">
              <CheckCircle2 className="mx-auto size-7 text-emerald-500" />
              <div className="mt-3 text-sm font-medium text-slate-700">
                当前筛选下没有待推进项目
              </div>
              <p className="mt-1 text-xs text-slate-500">
                可切换阶段，或从新的采购需求开始。
              </p>
            </div>
          ) : (
            <div>
              {filteredSourcing.map((requisition, index) => (
                <div
                  key={requisition.id}
                  className={index > 0 ? "border-t border-slate-100" : ""}
                >
                  <div className="grid gap-3 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_130px_190px_120px_150px] lg:items-center lg:gap-4">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">
                        {requisition.title ?? "未命名采购需求"}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {requisition.lines
                          ?.map(
                            (line) =>
                              `${line.itemName} ${displayNumber(Number(line.quantity))}${line.unit}`,
                          )
                          .join("；") || "等待补充物料明细"}
                        {requisition.attachmentCount
                          ? ` · ${requisition.attachmentCount} 个附件`
                          : ""}
                      </div>
                    </div>
                    <Badge tone="amber">待开始寻源</Badge>
                    <div className="text-xs text-slate-500">
                      尚未选择候选供应商
                    </div>
                    <div className="text-xs text-slate-500">—</div>
                    <div className="flex justify-start lg:justify-end">
                      <Button
                        size="sm"
                        onClick={() => {
                          setForm((current) => ({
                            ...current,
                            requisitionId: requisition.id,
                            title: requisition.title ?? current.title,
                            attachmentIds: [],
                          }));
                          setShowCreate(true);
                        }}
                      >
                        选择供应商
                        <UsersRound className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              {filteredRfqs.map((rfq, index) => {
                const stage = workflowStage(rfq);
                const isOpen = selectedId === rfq.id;
                const supplierCount =
                  rfq.supplierCount ?? rfq.supplierIds?.length ?? 0;
                const quotedCount =
                  rfq.quotedSupplierCount ?? rfq.quoteCount ?? 0;
                const nextLabel =
                  stage === "rfq"
                    ? quotedCount
                      ? "查看报价进度"
                      : "登记首份报价"
                    : stage === "compare"
                      ? "处理比价"
                      : stage === "award"
                        ? "进入定标"
                        : "查看结果";
                return (
                  <div
                    key={rfq.id}
                    className={
                      filteredSourcing.length > 0 || index > 0
                        ? "border-t border-slate-100"
                        : ""
                    }
                  >
                    <div
                      className={`grid gap-3 px-5 py-4 transition lg:grid-cols-[minmax(0,1fr)_130px_190px_120px_150px] lg:items-center lg:gap-4 ${isOpen ? "bg-blue-50/40" : "hover:bg-slate-50/70"}`}
                    >
                      <button
                        type="button"
                        className="min-w-0 text-left"
                        onClick={() => {
                          setSelectedId(isOpen ? null : rfq.id);
                          setWorkspaceTab("overview");
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold text-slate-900">
                            {businessRfqNumber(rfq)}
                          </span>
                          {stage === "compare" && (
                            <span className="shrink-0 text-[11px] font-medium text-amber-700">
                              需要补充或复核
                            </span>
                          )}
                        </div>
                        <div className="mt-1 line-clamp-1 text-xs text-slate-500">
                          {rfq.title
                            ?.replace(businessRfqNumber(rfq), "")
                            .replace(/^[｜|\s]+/, "") ||
                            rfq.lines?.[0]?.itemName ||
                            "未命名询价"}
                        </div>
                      </button>
                      <span
                        className={`w-fit rounded-md px-2 py-1 text-[11px] font-medium ${stage === "completed" ? "bg-emerald-50 text-emerald-700" : stage === "award" ? "bg-violet-50 text-violet-700" : stage === "compare" ? "bg-amber-50 text-amber-700" : "bg-blue-50 text-blue-700"}`}
                      >
                        {stageLabel[stage]}
                      </span>
                      <div>
                        <div className="text-xs font-medium text-slate-700">
                          已报价 {quotedCount}/{supplierCount} 家
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-blue-500"
                            style={{
                              width: `${supplierCount ? Math.min(100, (quotedCount / supplierCount) * 100) : 0}%`,
                            }}
                          />
                        </div>
                      </div>
                      <div className="text-xs text-slate-500">
                        {displayDate(rfq.deadline)}
                      </div>
                      <div className="flex justify-start gap-2 lg:justify-end">
                        <Button
                          size="sm"
                          variant={stage === "award" ? "default" : "outline"}
                          onClick={() => {
                            setSelectedId(rfq.id);
                            setWorkspaceTab(
                              stage === "award" || stage === "compare"
                                ? "award"
                                : stage === "rfq" && quotedCount
                                  ? "quotes"
                                  : "overview",
                            );
                          }}
                        >
                          {nextLabel}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSelectedId(isOpen ? null : rfq.id);
                            setWorkspaceTab("overview");
                          }}
                        >
                          {isOpen ? "收起" : "详情"}
                        </Button>
                      </div>
                    </div>
                    {isOpen && (
                      <div className="border-t border-blue-100 bg-[#fbfdff] px-5 py-5">
                        {detailLoading ? (
                          <div className="flex justify-center py-16 text-sm text-slate-400">
                            <Loader2 className="mr-2 size-4 animate-spin" />
                            正在读取询价、报价与比价快照…
                          </div>
                        ) : selected ? (
                          <div className="space-y-5">
                            {detailError && (
                              <div
                                className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700"
                                role="alert"
                              >
                                {detailError}
                              </div>
                            )}
                            <div className="flex flex-wrap items-start justify-between gap-4">
                              <div>
                                <h2 className="text-lg font-semibold text-slate-950">
                                  {businessRfqNumber(selected)} ·{" "}
                                  {selected.title
                                    ?.replace(businessRfqNumber(selected), "")
                                    .replace(/^[｜|\s]+/, "") || "询价详情"}
                                </h2>
                                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                                  <span>
                                    比较币种 {selected.currency ?? "—"}
                                  </span>
                                  <span>
                                    截止 {displayDate(selected.deadline)}
                                  </span>
                                  <span>已收 {quotes.length} 份报价</span>
                                </div>
                              </div>
                              <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                                {stageLabel[workflowStage(selected)]}
                              </span>
                            </div>
                            <RfqProgress status={selected.status} />
                            <div className="flex gap-5 border-b border-slate-200">
                              <WorkspaceTab
                                active={workspaceTab === "overview"}
                                onClick={() => setWorkspaceTab("overview")}
                              >
                                项目概览
                              </WorkspaceTab>
                              <WorkspaceTab
                                active={workspaceTab === "quotes"}
                                onClick={() => setWorkspaceTab("quotes")}
                              >
                                报价进度
                              </WorkspaceTab>
                              <WorkspaceTab
                                active={workspaceTab === "award"}
                                onClick={() => setWorkspaceTab("award")}
                              >
                                比价与定标
                              </WorkspaceTab>
                              <WorkspaceTab
                                active={workspaceTab === "documents"}
                                onClick={() => setWorkspaceTab("documents")}
                              >
                                文档
                              </WorkspaceTab>
                            </div>
                            {workspaceTab === "overview" && (
                              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(320px,0.95fr)]">
                                <div className="space-y-4">
                                  <section className="overflow-hidden rounded-xl border border-slate-200">
                                    <div className="border-b border-slate-200 px-3 py-3 text-sm font-semibold text-slate-900">
                                      采购需求与物料
                                    </div>
                                    {(selected.lines ?? []).length ? (
                                      (selected.lines ?? []).map((line) => (
                                        <div
                                          key={
                                            line.id ??
                                            line.itemCode ??
                                            line.itemName
                                          }
                                          className="grid gap-2 border-t border-slate-100 px-3 py-3 text-xs first:border-0 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
                                        >
                                          <div>
                                            <div className="font-medium text-slate-800">
                                              {line.itemName}
                                            </div>
                                            <div className="mt-1 text-slate-400">
                                              {line.itemCode ?? "未编码"}
                                              {line.technicalRequirements
                                                ? ` · ${line.technicalRequirements}`
                                                : ""}
                                            </div>
                                          </div>
                                          <span>
                                            {displayNumber(
                                              Number(line.quantity),
                                            )}{" "}
                                            {line.unit}
                                          </span>
                                          <span className="text-slate-500">
                                            需求 {displayDate(line.targetDate)}
                                          </span>
                                        </div>
                                      ))
                                    ) : (
                                      <div className="p-4 text-xs text-slate-400">
                                        RFQ 没有可报价的行数据。
                                      </div>
                                    )}
                                  </section>
                                  <section className="overflow-hidden rounded-xl border border-slate-200">
                                    <div className="border-b border-slate-200 px-3 py-3 text-sm font-semibold text-slate-900">
                                      候选供应商进度
                                    </div>
                                    {supplierRows.length ? (
                                      supplierRows.map(
                                        ({ supplier, quote }) => (
                                          <div
                                            key={supplier.id}
                                            className="grid grid-cols-[minmax(0,1fr)_90px_100px] items-center border-t border-slate-100 px-3 py-3 text-xs first:border-0"
                                          >
                                            <span className="truncate font-medium text-slate-700">
                                              <span data-preserve-language>{supplier.name ?? supplier.id}</span>
                                            </span>
                                            <span
                                              className={
                                                quote
                                                  ? "text-emerald-700"
                                                  : "text-amber-700"
                                              }
                                            >
                                              {quote ? "已报价" : "等待报价"}
                                            </span>
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setWorkspaceTab("quotes");
                                                if (!quote)
                                                  setShowQuoteEntry(true);
                                              }}
                                              className="text-right text-blue-600 hover:underline"
                                            >
                                              {quote ? "查看报价" : "登记报价"}
                                            </button>
                                          </div>
                                        ),
                                      )
                                    ) : (
                                      <div className="p-4 text-xs text-amber-700">
                                        该 RFQ 没有关联的供应商档案。
                                      </div>
                                    )}
                                  </section>
                                </div>
                                <section className="rounded-xl border border-slate-200 p-4">
                                  <div className="mb-3 text-sm font-semibold text-slate-900">
                                    已保存的业务记录
                                  </div>
                                  {timeline.length ? (
                                    <div className="space-y-4">
                                      {timeline
                                        .slice(-6)
                                        .reverse()
                                        .map((event, eventIndex) => (
                                          <div
                                            key={event.key}
                                            className="flex gap-3 text-xs"
                                          >
                                            <span
                                              className={`mt-1.5 size-2 shrink-0 rounded-full ${eventIndex === 0 ? "bg-blue-600" : "bg-slate-300"}`}
                                            />
                                            <div>
                                              <div>
                                                <span className="mr-2 text-slate-400">
                                                  {event.at
                                                    ? displayDate(event.at)
                                                    : "已保存"}
                                                </span>
                                                <span className="font-medium text-slate-700">
                                                  {event.title}
                                                </span>
                                              </div>
                                              <div className="mt-1 text-slate-500">
                                                {event.note}
                                              </div>
                                            </div>
                                          </div>
                                        ))}
                                    </div>
                                  ) : (
                                    <div className="text-xs text-slate-400">
                                      暂无可展示的业务记录。
                                    </div>
                                  )}
                                </section>
                              </div>
                            )}
                            {workspaceTab === "quotes" && (
                              <div className="space-y-4">
                                {quotes.length === 0 ? (
                                  <EmptyQuoteState
                                    onEntry={() => setShowQuoteEntry(true)}
                                  />
                                ) : (
                                  <>
                                    <div className="overflow-x-auto rounded-xl border border-slate-200">
                                      <table className="w-full min-w-[680px] text-left text-xs">
                                        <thead className="bg-slate-50 text-slate-500">
                                          <tr>
                                            <th className="px-3 py-2.5">
                                              供应商
                                            </th>
                                            <th className="px-3 py-2.5">
                                              单价
                                            </th>
                                            <th className="px-3 py-2.5">
                                              交期
                                            </th>
                                            <th className="px-3 py-2.5">MOQ</th>
                                            <th className="px-3 py-2.5">
                                              付款条件
                                            </th>
                                            <th className="px-3 py-2.5">
                                              状态
                                            </th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {quotes.map((quote) => {
                                            const line = quote.lines?.[0];
                                            return (
                                              <tr
                                                key={
                                                  quote.id ?? quote.supplierId
                                                }
                                                className="border-t border-slate-100"
                                              >
                                                <td className="px-3 py-3 font-medium text-slate-800">
                                                  <span data-preserve-language={quote?.supplierName || quote?.supplierId ? true : undefined}>{quote.supplierName ??
                                                    quote.supplierId ??
                                                    "未知供应商"}</span>
                                                </td>
                                                <td className="px-3 py-3">
                                                  {displayNumber(
                                                    line?.unitPrice,
                                                  )}{" "}
                                                  {quote.currency ?? ""}
                                                </td>
                                                <td className="px-3 py-3 text-emerald-700">
                                                  {displayNumber(
                                                    line?.leadTimeDays,
                                                    0,
                                                  )}{" "}
                                                  天
                                                </td>
                                                <td className="px-3 py-3">
                                                  {displayNumber(line?.moq)}
                                                </td>
                                                <td className="px-3 py-3">
                                                  {line?.paymentTerms || "—"}
                                                </td>
                                                <td className="px-3 py-3">
                                                  <span className="rounded bg-emerald-50 px-1.5 py-1 text-emerald-700">
                                                    已登记
                                                  </span>
                                                </td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setShowQuoteEntry(true)}
                                    >
                                      <Plus className="size-3.5" />
                                      登记修订报价
                                    </Button>
                                  </>
                                )}
                                {showQuoteEntry && (
                                  <QuoteEntry
                                    selected={selected}
                                    suppliers={quoteCandidateSuppliers}
                                    quoteSupplierId={quoteSupplierId}
                                    setQuoteSupplierId={setQuoteSupplierId}
                                    quoteCurrency={quoteCurrency}
                                    setQuoteCurrency={setQuoteCurrency}
                                    quoteValidUntil={quoteValidUntil}
                                    setQuoteValidUntil={setQuoteValidUntil}
                                    quoteLineForm={quoteLineForm}
                                    updateQuoteLine={updateQuoteLine}
                                    minimumDate={minimumDate}
                                    quoteSaving={quoteSaving}
                                    onCancel={() => setShowQuoteEntry(false)}
                                    onSubmit={() => void enterQuote()}
                                  />
                                )}
                              </div>
                            )}
                            {workspaceTab === "award" && (
                              <div className="space-y-4">
                                {!comparison ? (
                                  <div className="rounded-xl border border-dashed border-slate-200 p-7 text-center">
                                    <BarChart3 className="mx-auto mb-2 size-6 text-slate-300" />
                                    <div className="text-sm font-medium text-slate-700">
                                      尚未生成比价快照
                                    </div>
                                    <p className="mt-1 text-xs text-slate-500">
                                      系统会基于已登记的真实报价创建可审计快照。
                                    </p>
                                    <div className="mx-auto mt-4 max-w-sm">
                                      {foreignQuoteCurrencies.map(
                                        (currency) => {
                                          const pair = `${currency}/${comparisonTarget}`;
                                          return (
                                            <label
                                              key={pair}
                                              className="mb-2 block text-left text-xs text-slate-600"
                                            >
                                              汇率 {pair}
                                              <input
                                                value={rateInputs[pair] ?? ""}
                                                onChange={(event) =>
                                                  setRateInputs((current) => ({
                                                    ...current,
                                                    [pair]: event.target.value,
                                                  }))
                                                }
                                                className={inputClassName}
                                              />
                                            </label>
                                          );
                                        },
                                      )}
                                      <Button
                                        disabled={
                                          quotes.length === 0 || compareLoading
                                        }
                                        onClick={() => void compare()}
                                      >
                                        {compareLoading
                                          ? "正在生成可审计比价…"
                                          : "生成比价快照"}
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <ComparisonAndAward
                                    comparison={comparison}
                                    selected={selected}
                                    awardSelections={awardSelections}
                                    setAwardSelections={setAwardSelections}
                                    awardReason={awardReason}
                                    setAwardReason={setAwardReason}
                                    awardSaving={awardSaving}
                                    awardError={awardError}
                                    awardConfirming={awardConfirming}
                                    setAwardConfirming={setAwardConfirming}
                                    allAwarded={allAwarded}
                                    hasAwardCandidates={hasAwardCandidates}
                                    onSubmit={() => void submitAward()}
                                    awardSuccess={awardSuccess}
                                    purchaseOrderTotal={purchaseOrderTotal}
                                  />
                                )}
                              </div>
                            )}
                            {workspaceTab === "documents" && (
                              <div>
                                {(selected.attachments ?? []).length ? (
                                  <div className="space-y-2">
                                    {selected.attachments!.map((attachment) => (
                                      <div
                                        key={attachment.id}
                                        className="flex items-center gap-3 rounded-xl border border-slate-200 p-3"
                                      >
                                        <div className="rounded-lg bg-slate-50 p-2">
                                          <FileText className="size-4 text-slate-500" />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                          <div className="truncate text-xs font-medium text-slate-800">
                                            {attachment.fileName}
                                          </div>
                                          <div className="mt-1 text-[10px] text-slate-400">
                                            v{attachment.version ?? 1} ·
                                            已冻结到 RFQ · SHA-256{" "}
                                            {attachment.sha256?.slice(0, 12) ??
                                              "—"}
                                            …
                                          </div>
                                        </div>
                                        {attachment.url && (
                                          <a
                                            href={attachment.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-xs text-blue-600 hover:underline"
                                          >
                                            查看文件
                                          </a>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center">
                                    <Inbox className="mx-auto mb-2 size-6 text-slate-300" />
                                    <div className="text-sm font-medium text-slate-700">
                                      该 RFQ 未选择需求附件
                                    </div>
                                    <p className="mt-1 text-xs text-slate-500">
                                      系统不会默认将采购需求中的全部文件发给供应商。
                                    </p>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="py-12 text-center text-sm text-slate-400">
                            未能读取该 RFQ 的详情。
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );

  /*
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight text-slate-950">询价与报价</h1><p className="mt-1 text-sm text-slate-500">创建询价草稿，查看结构化报价；发送邮件与自动定标暂不在此操作。</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => void load()} disabled={loading || syncing}><RefreshCw className="size-3.5" />刷新</Button><Button variant="outline" size="sm" onClick={() => setShowSupplierForm((value) => !value)}><UserPlus className="size-3.5" />登记已有供应商</Button><Button variant="outline" size="sm" onClick={() => void syncSuppliers()} disabled={syncing}><RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />{syncing ? "同步中…" : "从 ERP 同步供应商"}</Button><Button size="sm" onClick={() => { setShowCreate(true); setSuccess(null); }}><Plus className="size-3.5" />创建询价草稿</Button></div></div>
    {success && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" role="status">{success}</div>}
    {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</div>}
    {showSupplierForm && <Card><CardHeader><CardTitle>登记已有供应商</CardTitle><CardDescription>这是已有供应商档案登记，不代表供应商准入或审批。</CardDescription></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><label className="text-xs font-medium text-slate-600">供应商名称 *<input aria-label="供应商名称" value={supplierForm.name} onChange={(event) => setSupplierForm({ ...supplierForm, name: event.target.value })} className={inputClassName} /></label><label className="text-xs font-medium text-slate-600">币种<select aria-label="供应商币种" value={supplierForm.currency} onChange={(event) => setSupplierForm({ ...supplierForm, currency: event.target.value })} className={inputClassName}><option>CNY</option><option>USD</option><option>EUR</option></select></label><label className="text-xs font-medium text-slate-600">联系人 *<input aria-label="联系人" value={supplierForm.contactName} onChange={(event) => setSupplierForm({ ...supplierForm, contactName: event.target.value })} className={inputClassName} /></label><label className="text-xs font-medium text-slate-600">邮箱 *<input type="email" aria-label="邮箱" value={supplierForm.email} onChange={(event) => setSupplierForm({ ...supplierForm, email: event.target.value })} className={inputClassName} /></label><label className="text-xs font-medium text-slate-600">电话<input aria-label="电话" value={supplierForm.phone} onChange={(event) => setSupplierForm({ ...supplierForm, phone: event.target.value })} className={inputClassName} /></label></div><div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => setShowSupplierForm(false)}>取消</Button><Button disabled={!supplierForm.name.trim() || !supplierForm.contactName.trim() || !EMAIL_PATTERN.test(supplierForm.email.trim()) || supplierSaving} onClick={() => void registerSupplier()}>{supplierSaving ? "登记中…" : "登记档案"}</Button></div></CardContent></Card>}
    {showCreate && <Card><CardHeader><div className="flex items-start justify-between"><div><CardTitle>从采购需求创建询价草稿</CardTitle><CardDescription>只创建 RFQ，不发送邮件、不自动定标。</CardDescription></div><button type="button" aria-label="关闭创建表单" onClick={() => setShowCreate(false)}><X className="size-4 text-slate-400" /></button></div></CardHeader><CardContent className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2"><label className="text-xs font-medium text-slate-600">采购需求<select value={form.requisitionId} onChange={(event) => { const req = requisitions.find((item) => item.id === event.target.value); setForm((current) => ({ ...current, requisitionId: event.target.value, title: current.title || req?.title || "" })); }} className={inputClassName}><option value="">选择一条需求</option>{requisitions.map((req) => <option key={req.id} value={req.id}>{req.title ?? req.id}</option>)}</select></label><label className="text-xs font-medium text-slate-600">标题<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} className={inputClassName} placeholder="如：M6 紧固件询价" /></label><label className="text-xs font-medium text-slate-600">报价截止日期<input type="date" min={minimumFutureDate} value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })} className={inputClassName} /></label><label className="text-xs font-medium text-slate-600">统一比较币种<select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })} className={inputClassName}><option>CNY</option><option>USD</option><option>EUR</option></select></label></div>
      <div><div className="mb-2 flex items-center justify-between"><div className="text-sm font-semibold text-slate-800">候选供应商</div>{suppliers.length === 0 && <Button variant="outline" size="sm" onClick={() => void syncSuppliers()} disabled={syncing}><RefreshCw className={`size-3.5 ${syncing ? "animate-spin" : ""}`} />从 ERP 同步现有供应商</Button>}</div>{suppliers.length === 0 ? <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-500">尚未同步已有供应商。同步是只读操作，不做供应商准入，也不会修改 ERP。</div> : <div className="grid gap-2 sm:grid-cols-2">{suppliers.map((supplier) => <label key={supplier.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 p-3 text-sm hover:border-blue-300"><input type="checkbox" checked={form.supplierIds.includes(supplier.id)} onChange={() => toggleSupplier(supplier.id)} /><span className="font-medium"><span data-preserve-language>{supplier.name ?? supplier.id}</span></span><span className="ml-auto text-xs text-slate-400"><span data-preserve-language={supplier.email ? true : undefined}>{supplier.email ?? ""}</span></span></label>)}</div>}</div>
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setShowCreate(false)}>取消</Button><Button disabled={!canSubmit || suppliers.length === 0} onClick={() => void create()}><Send className="size-3.5" />{saving ? "创建中…" : "创建询价草稿"}</Button></div>
    </CardContent></Card>}
    <div className="grid gap-5 2xl:grid-cols-[minmax(280px,0.7fr)_minmax(0,1.3fr)]"><Card><CardHeader><CardTitle>RFQ 列表</CardTitle><CardDescription>{loading ? "正在读取真实询价…" : `${rfqs.length} 条询价记录`}</CardDescription></CardHeader><CardContent>{loading ? <div className="flex items-center justify-center py-16 text-sm text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />加载中…</div> : rfqs.length === 0 ? <div className="rounded-xl border border-dashed border-slate-200 px-4 py-16 text-center text-sm text-slate-400"><ClipboardCheck className="mx-auto mb-2 size-6" />暂无询价草稿</div> : <div className="space-y-2">{rfqs.map((rfq) => <button type="button" key={rfq.id} onClick={() => setSelectedId(rfq.id)} className={`w-full rounded-xl border p-3 text-left transition ${selectedId === rfq.id ? "border-blue-300 bg-blue-50/50" : "border-slate-200 hover:border-slate-300"}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-semibold text-slate-800">{rfq.title ?? rfq.id}</span><Badge tone="blue">{rfq.status ?? "draft"}</Badge></div><div className="mt-1 break-all text-xs text-slate-500">{rfq.currency ?? ""}{rfq.deadline ? ` · 截止 ${displayDate(rfq.deadline)}` : ""} · {rfq.id}</div></button>)}</div>}</CardContent></Card>
      <Card><CardHeader><CardTitle>询价详情</CardTitle><CardDescription>业务事实、结构化报价和逐行比价共用同一 RFQ 上下文。</CardDescription></CardHeader><CardContent>
        {detailLoading ? <div className="flex items-center justify-center py-16 text-sm text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />正在读取询价和报价…</div> : null}
        {detailError ? <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{detailError}</div> : null}
        {!detailLoading && !selected ? <div className="rounded-xl border border-dashed border-slate-200 px-4 py-16 text-center text-sm text-slate-400">选择一条 RFQ 查看详情</div> : null}
        {!detailLoading && selected ? <div className="space-y-6">
          <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-base font-semibold text-slate-900">{selected.title ?? selected.id}</div><div className="mt-1 break-all text-xs text-slate-500">{selected.id}</div></div><Badge tone="blue">{selected.status ?? "draft"}</Badge></div>
            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-3"><div><div className="text-xs text-slate-400">比较币种</div><div className="mt-1 font-medium text-slate-800">{selected.currency ?? "—"}</div></div><div><div className="text-xs text-slate-400">报价截止</div><div className="mt-1 font-medium text-slate-800">{displayDate(selected.deadline)}</div></div><div><div className="text-xs text-slate-400">已收报价</div><div className="mt-1 font-medium text-slate-800">{quotes.length} 份</div></div></div>
          </section>

          <section><div className="mb-2 text-sm font-semibold text-slate-900">询价行</div><div className="space-y-2">{(selected.lines ?? []).length === 0 ? <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500">RFQ 没有可报价的行数据。</div> : (selected.lines ?? []).map((line) => <div key={line.id ?? line.itemCode ?? line.itemName} className="grid gap-2 rounded-lg border border-slate-200 p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto]"><div><div className="font-medium text-slate-800">{line.itemName}</div><div className="mt-1 text-xs text-slate-400">{line.itemCode ?? line.id ?? "未编码"}{line.technicalRequirements ? ` · ${line.technicalRequirements}` : ""}</div></div><div className="text-slate-600">{displayNumber(Number(line.quantity))} {line.unit}</div><div className="text-slate-500">需求 {displayDate(line.targetDate)}</div></div>)}</div></section>

          <section><div className="mb-2 text-sm font-semibold text-slate-900">候选供应商</div>{quoteCandidateSuppliers.length === 0 ? <div className="rounded-lg border border-dashed border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">未找到该 RFQ 的候选供应商档案，不能登记报价。</div> : <div className="flex flex-wrap gap-2">{quoteCandidateSuppliers.map((supplier) => <Badge key={supplier.id} tone="neutral"><span data-preserve-language>{supplier.name ?? supplier.id}</span>{supplier.currency ? ` · ${supplier.currency}` : ""}</Badge>)}</div>}</section>

          <section className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><div className="text-sm font-semibold text-slate-900">登记结构化报价</div><div className="mt-1 text-xs text-slate-500">人工核对后录入；登记不代表定标或发送邮件。</div></div><Badge tone="amber">需人工核对</Badge></div>
            <div className="mt-4 grid gap-3 md:grid-cols-3"><label className="text-xs font-medium text-slate-600">报价供应商 *<select aria-label="报价供应商" value={quoteSupplierId} onChange={(event) => setQuoteSupplierId(event.target.value)} className={inputClassName}><option value="">选择候选供应商</option>{quoteCandidateSuppliers.map((supplier) => <option data-preserve-language key={supplier.id} value={supplier.id}>{supplier.name ?? supplier.id}</option>)}</select></label><label className="text-xs font-medium text-slate-600">报价币种 *<select aria-label="报价币种" value={quoteCurrency} onChange={(event) => setQuoteCurrency(event.target.value)} className={inputClassName}><option>CNY</option><option>USD</option><option>EUR</option></select></label><label className="text-xs font-medium text-slate-600">报价有效期 *<input aria-label="报价有效期" type="date" min={minimumDate} value={quoteValidUntil} onChange={(event) => setQuoteValidUntil(event.target.value)} className={inputClassName} /></label></div>
            <div className="mt-4 space-y-3">{(selected.lines ?? []).map((line) => { const lineId = line.id ?? ""; const value = quoteLineForm(lineId); return <div key={lineId || line.itemCode || line.itemName} className="rounded-xl border border-slate-200 bg-slate-50/50 p-3"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-medium text-slate-800">{line.itemName}</div><div className="text-xs text-slate-500">需求 {displayNumber(Number(line.quantity))} {line.unit}</div></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7"><label className="text-xs font-medium text-slate-600">单价 *<input aria-label={`${line.itemName} 单价`} inputMode="decimal" value={value.unitPrice} onChange={(event) => updateQuoteLine(lineId, { unitPrice: event.target.value })} className={inputClassName} /></label><label className="text-xs font-medium text-slate-600">税务口径 *<select aria-label={`${line.itemName} 税务口径`} value={value.taxStatus} onChange={(event) => updateQuoteLine(lineId, { taxStatus: event.target.value as "included" | "excluded" | "unknown" })} className={inputClassName}><option value="unknown">未说明/待复核</option><option value="included">含税</option><option value="excluded">未税</option></select></label><label className="text-xs font-medium text-slate-600">报价数量 *<input aria-label={`${line.itemName} 报价数量`} inputMode="decimal" value={value.quotedQuantity} onChange={(event) => updateQuoteLine(lineId, { quotedQuantity: event.target.value })} className={inputClassName} /></label><label className="text-xs font-medium text-slate-600">MOQ<input aria-label={`${line.itemName} MOQ`} inputMode="decimal" value={value.moq} onChange={(event) => updateQuoteLine(lineId, { moq: event.target.value })} className={inputClassName} /></label><label className="text-xs font-medium text-slate-600">承诺交期<input aria-label={`${line.itemName} 承诺交期`} type="date" value={value.promisedAt} onChange={(event) => updateQuoteLine(lineId, { promisedAt: event.target.value })} className={inputClassName} /></label><label className="text-xs font-medium text-slate-600">交期（天）*<input aria-label={`${line.itemName} 交期天数`} inputMode="numeric" value={value.leadTimeDays} onChange={(event) => updateQuoteLine(lineId, { leadTimeDays: event.target.value })} className={inputClassName} /></label><label className="text-xs font-medium text-slate-600">付款条款 *<input aria-label={`${line.itemName} 付款条款`} value={value.paymentTerms} onChange={(event) => updateQuoteLine(lineId, { paymentTerms: event.target.value })} placeholder="如：月结30天" className={inputClassName} /></label></div></div>; })}</div>
            <div className="mt-4 flex justify-end"><Button disabled={selected.status === "awarded" || !quoteSupplierId || !quoteCurrency || !quoteValidUntil || quoteSaving || quoteCandidateSuppliers.length === 0} onClick={() => void enterQuote()}>{quoteSaving ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}{selected.status === "awarded" ? "已定标，不能继续录价" : quoteSaving ? "提交中…" : selected.status === "pending_award" || selected.status === "compared" ? "登记修订报价" : "登记报价"}</Button></div>
          </section>

          <section><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div><div className="text-sm font-semibold text-slate-900">已收报价</div><div className="mt-1 text-xs text-slate-500">数据来自统一 API 和 SQLite，刷新后保留。</div></div><Badge tone="neutral">{quotes.length} 份</Badge></div>{quotes.length === 0 ? <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500">尚未收到结构化报价。</div> : <div className="space-y-3">{quotes.map((quote) => <div key={quote.id ?? `${quote.supplierId}:${quote.receivedAt}`} className="rounded-xl border border-slate-200 p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><div className="text-sm font-semibold text-slate-800"><span data-preserve-language={quote?.supplierName || quote?.supplierId ? true : undefined}>{quote.supplierName ?? quote.supplierId ?? "未知供应商"}</span></div><div className="mt-1 text-xs text-slate-500">收到 {displayDate(quote.receivedAt)} · 有效至 {displayDate(quote.validUntil)}</div></div><Badge tone="blue">{quote.currency ?? "—"}</Badge></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{(quote.lines ?? []).map((line, index) => { const rfqLine = (selected.lines ?? []).find((item) => item.id === line.rfqLineId); return <div key={`${line.rfqLineId ?? "line"}:${index}`} className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600"><div className="flex items-center justify-between gap-2"><div className="font-medium text-slate-800">{rfqLine?.itemName ?? line.itemName ?? line.rfqLineId ?? `报价行 ${index + 1}`}</div><Badge tone={line.taxStatus === "unknown" ? "amber" : "neutral"}>{TAX_STATUS_LABEL[line.taxStatus ?? "unknown"]}</Badge></div><div className="mt-1">{displayNumber(line.unitPrice)} {quote.currency}/{line.uom ?? rfqLine?.unit ?? "—"} · 数量 {displayNumber(line.quotedQuantity)} · 交期 {displayNumber(line.leadTimeDays, 0)} 天</div><div className="mt-1">MOQ {displayNumber(line.moq)} · 承诺 {displayDate(line.promisedAt)} · {line.paymentTerms || "未填付款条款"}</div></div>; })}</div></div>)}</div>}</section>

          <section className="rounded-xl border border-blue-200 bg-blue-50/40 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2 text-sm font-semibold text-slate-900"><BarChart3 className="size-4 text-blue-600" />逐行标准化比价</div><div className="mt-1 text-xs text-slate-500">权重：价格 40%、交期 25%、付款 10%、历史绩效 25%。AI 只推荐，定标仍需人工。</div></div><Badge tone="violet">比较币种 {comparisonTarget}</Badge></div>
            {foreignQuoteCurrencies.length > 0 ? <div className="mt-4 grid gap-3 sm:grid-cols-2">{foreignQuoteCurrencies.map((currency) => { const pair = `${currency}/${comparisonTarget}`; return <label key={pair} className="text-xs font-medium text-slate-600">汇率 {pair} *<input aria-label={`汇率 ${pair}`} inputMode="decimal" value={rateInputs[pair] ?? ""} onChange={(event) => setRateInputs((current) => ({ ...current, [pair]: event.target.value }))} placeholder={`1 ${currency} = ? ${comparisonTarget}`} className={inputClassName} /></label>; })}</div> : <div className="mt-3 text-xs text-slate-500">所有报价均为 {comparisonTarget}，无需汇率快照。</div>}
            <div className="mt-4 flex justify-end"><Button variant="outline" disabled={selected.status === "pending_award" || selected.status === "awarded" || quotes.length === 0 || compareLoading} onClick={() => void compare()}>{compareLoading ? <Loader2 className="size-3.5 animate-spin" /> : <BarChart3 className="size-3.5" />}{compareLoading ? "正在比较…" : "生成比价"}</Button></div>
          </section>

          {comparison ? <section><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-semibold text-slate-900">比价结果</div><Badge tone="green">{comparison.comparisonSnapshotId ? "已持久化快照" : "已按 RFQ 行生成"}</Badge></div><div className="space-y-4">{comparison.lineComparisons.map((lineResult) => { const rfqLine = (selected.lines ?? []).find((line) => line.id === lineResult.rfqLineId); return <div key={lineResult.rfqLineId} className="rounded-xl border border-slate-200 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-sm font-semibold text-slate-900">{rfqLine?.itemName ?? lineResult.itemId ?? lineResult.rfqLineId}</div><div className="mt-1 text-xs text-slate-500">采购数量 {displayNumber(lineResult.purchaseQuantity)} · {lineResult.comparisonCurrency ?? comparisonTarget}</div></div>{lineResult.recommendedSupplierId ? <Badge tone="green">推荐 {lineResult.quotes?.find((quote) => quote.supplierId === lineResult.recommendedSupplierId)?.supplierName ?? lineResult.recommendedSupplierId}</Badge> : <Badge tone="amber">无可用推荐</Badge>}</div><div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">{lineResult.recommendationReason ?? "暂无推荐理由。"}</div><div className="mt-3 space-y-2">{(lineResult.quotes ?? []).map((quote) => <div key={quote.quoteLineId ?? quote.supplierId} className={`rounded-lg border p-3 ${quote.supplierId === lineResult.recommendedSupplierId ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200 bg-white"}`}><div className="flex flex-wrap items-center gap-x-3 gap-y-2"><span className="w-6 text-center text-sm font-semibold text-slate-700">{quote.rank ?? "—"}</span><span className="min-w-40 flex-1 text-sm font-medium text-slate-900"><span data-preserve-language>{quote.supplierName ?? quote.supplierId}</span></span><span className="text-sm text-slate-700">总成本 {displayNumber(quote.totalCost)} {lineResult.comparisonCurrency ?? comparisonTarget}</span><span className="text-xs text-slate-500">交期 {displayNumber(quote.leadTimeDays, 0)} 天</span><Badge tone={quote.eligibility === "eligible" ? "green" : "amber"}><span data-preserve-language={ELIGIBILITY_LABEL[quote.eligibility] ? undefined : true}>{ELIGIBILITY_LABEL[quote.eligibility] ?? quote.eligibility}</span></Badge></div><div className="mt-2 pl-0 text-xs text-slate-500 sm:pl-9">{quote.reason}{quote.paymentTerms ? ` · ${quote.paymentTerms}` : ""}{quote.scores?.total !== undefined ? ` · 综合分 ${displayNumber(quote.scores.total)}` : ""}</div></div>)}</div></div>; })}</div></section> : null}
          {comparison?.comparisonSnapshotId && !hasAwardCandidates ? <section className="rounded-xl border border-amber-200 bg-amber-50/50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-sm font-semibold text-amber-950">报价需要补充信息</div><div className="mt-1 text-xs text-amber-800">至少一条询价行没有可定标报价。请补充税务口径或其他缺失字段并登记为修订报价；旧报价和本次比价快照会保留用于审计。</div></div><Badge tone="amber">暂不可定标</Badge></div></section> : null}
          {comparison?.comparisonSnapshotId && hasAwardCandidates && selected.status === "pending_award" ? <section className="rounded-xl border border-amber-200 bg-amber-50/50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="text-sm font-semibold text-slate-900">人工逐行定标</div><div className="mt-1 text-xs text-slate-600">请选择每一行的合格报价；系统推荐仅供参考，不会自动选择。</div></div><Badge tone="amber">必须人工确认</Badge></div><div className="mt-4 space-y-3">{awardableLines.map((line) => <div key={line.rfqLineId} className="rounded-lg border border-amber-100 bg-white p-3"><div className="mb-2 text-sm font-medium text-slate-900">{(selected.lines ?? []).find((item) => item.id === line.rfqLineId)?.itemName ?? line.itemId ?? line.rfqLineId}</div><div className="space-y-2">{(line.quotes ?? []).filter((quote) => quote.eligibility === "eligible").map((quote) => <label key={quote.quoteLineId ?? quote.supplierId} className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 p-2 text-xs hover:border-amber-300"><input type="radio" name={`award-${line.rfqLineId}`} checked={awardSelections[line.rfqLineId] === (quote.quoteLineId ?? "")} onChange={() => setAwardSelections((current) => ({ ...current, [line.rfqLineId]: quote.quoteLineId ?? "" }))} disabled={awardSaving} /><span className="min-w-0 flex-1"><span className="font-medium text-slate-800"><span data-preserve-language>{quote.supplierName ?? quote.supplierId}</span></span><span className="ml-2 text-slate-500">总成本 {displayNumber(quote.totalCost)} · 交期 {displayNumber(quote.leadTimeDays, 0)} 天</span></span>{quote.supplierId === line.recommendedSupplierId && <Badge tone="violet">规则推荐</Badge>}</label>)}</div></div>)}</div><label className="mt-4 block text-xs font-medium text-slate-700">定标原因 *<textarea aria-label="定标原因" value={awardReason} onChange={(event) => setAwardReason(event.target.value)} disabled={awardSaving} placeholder="说明选择供应商的业务原因" className="mt-1 min-h-20 w-full rounded-lg border border-slate-200 bg-white p-2 text-sm" /></label>{awardError && <div className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-700" role="alert">{awardError}</div>}<div className="mt-4 flex justify-end"><Button disabled={!allAwarded || !awardReason.trim() || awardSaving} onClick={() => setAwardConfirming(true)}>{awardSaving ? "提交中…" : "展开确认摘要"}</Button></div>{awardConfirming && <div className="mt-4 rounded-lg border border-amber-300 bg-white p-3"><div className="text-sm font-semibold">确认定标并生成 PO 草稿</div><div className="mt-1 text-xs text-slate-600">将按已选择的供应商和币种生成真实 PO Draft，不代表已写入 ERP。</div><div className="mt-3 space-y-1 text-xs">{awardableLines.map((line) => { const quote = line.quotes?.find((item) => item.quoteLineId === awardSelections[line.rfqLineId]); return <div key={line.rfqLineId}>{(selected.lines ?? []).find((item) => item.id === line.rfqLineId)?.itemName ?? line.rfqLineId}：<span data-preserve-language>{quote?.supplierName ?? quote?.supplierId}</span> · 数量 {displayNumber(line.purchaseQuantity)}</div>; })}</div><div className="mt-3 flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => setAwardConfirming(false)} disabled={awardSaving}>返回修改</Button><Button onClick={() => void submitAward()} disabled={awardSaving}>{awardSaving ? <Loader2 className="size-3.5 animate-spin" /> : null}{awardSaving ? "定标中…" : "确认定标并生成 PO 草稿"}</Button></div></div>}</section> : null}
          {awardSuccess && <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="text-sm font-semibold text-emerald-900">定标完成，PO Draft 已生成</div><div className="mt-1 text-xs text-emerald-800">以下是本地真实草稿，不代表已写入 ERP。</div><div className="mt-3 grid gap-2 sm:grid-cols-2">{(awardSuccess.purchaseOrders ?? []).map((po, index) => <div key={po.id ?? index} className="rounded-lg border border-emerald-100 bg-white p-3 text-xs"><div className="font-medium text-slate-800">{po.id ?? "PO Draft"}</div><div className="mt-1 text-slate-600"><span data-preserve-language={po.supplierName || po.supplierId ? true : undefined}>{po.supplierName ?? po.supplierId ?? "供应商未提供"}</span> · {po.currency ?? selected.currency ?? "—"} · 总额 {displayNumber(purchaseOrderTotal(po))}</div><Badge tone="amber">{po.status ?? "draft"}</Badge></div>)}</div></section>}
        </div> : null}
      </CardContent></Card></div>
  </div>;
*/
}
