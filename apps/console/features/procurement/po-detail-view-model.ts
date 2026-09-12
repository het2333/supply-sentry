import { procurementCalendarDate } from "./tenant-locale";
import { evaluateSupplierConfirmationVariance } from "@readywork/procurement-confirmation-contract";
import type { SupplierReplyAnalysis, SupplierReplyField } from "@readywork/procurement-supplier-reply-contract";

export type PoDetailRecord = Record<string, unknown>;

export type PoDetailItemRow = {
  id: string;
  label: string;
  reference: string;
  sku?: string;
  category?: string;
  uom?: string;
  orderedQty?: number;
  confirmedQty?: number;
  /** Ordered minus confirmed, only when a persisted confirmation quantity exists. */
  remainderQty?: number;
  shippedQty?: number;
  receivedQty?: number;
  unitPrice?: number;
  tax?: number;
  total?: number;
  status?: string;
  /** Explicit delayed quantity supplied by a persisted line/projection fact. */
  delayedQuantity?: number;
  currency?: string;
  requestedAt?: string;
  confirmedPromisedAt?: string;
  quantityVariance?: number;
  unitPriceVariance?: number;
  promisedAtVarianceDays?: number;
  varianceKnown: boolean;
  hasVariance: boolean;
};

export type PoDetailStageState = "completed" | "active" | "pending" | "blocked";

const poDetailStageStateLabels: Record<PoDetailStageState, string> = {
  completed: "Completed",
  active: "In progress",
  pending: "Pending",
  blocked: "Blocked",
};

/**
 * Adds only presentation metadata to the ordered stage contract returned by
 * the API. It never advances, completes, or reorders a business stage.
 */
export function poDetailStageTimelineRows<T extends { state: PoDetailStageState }>(stages: readonly T[]) {
  return stages.map((stage, index) => ({
    ...stage,
    ordinal: index + 1,
    stateLabel: poDetailStageStateLabels[stage.state],
    connector: index === stages.length - 1
      ? "none" as const
      : stage.state === "completed"
        ? "completed" as const
        : "pending" as const,
  }));
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Joins immutable PO lines with the latest persisted quantity projection and
 * structured supplier-confirmation lines. It never invents a confirmed,
 * shipped, or received quantity when the corresponding fact is absent.
 */
export function buildPoDetailItemRows(input: {
  po: PoDetailRecord;
  lines: PoDetailRecord[];
  quantityProjections: PoDetailRecord[];
  confirmationLines: PoDetailRecord[];
}): PoDetailItemRow[] {
  const projections = new Map(input.quantityProjections.map((item) => [text(item.poLineId) ?? "", item]));
  const confirmations = new Map(input.confirmationLines.map((item) => [text(item.poLineId) ?? "", item]));

  return input.lines.map((line, index) => {
    const id = text(line.id) ?? `line:${index + 1}`;
    const projection = projections.get(id);
    const confirmation = confirmations.get(id);
    const quantityVariance = number(confirmation?.quantityVariance);
    const unitPriceVariance = number(confirmation?.unitPriceVariance);
    const promisedAtVarianceDays = number(confirmation?.promisedAtVarianceDays);
    const varianceKnown = [quantityVariance, unitPriceVariance, promisedAtVarianceDays]
      .some((value) => value !== undefined);
    const orderedQty = number(projection?.orderedQty) ?? number(line.orderedQty);
    const confirmedQty = number(projection?.confirmedQty) ?? number(confirmation?.confirmedQty);
    const unitPrice = number(line.unitPrice);
    const tax = number(line.tax) ?? number(line.taxRate);
    const persistedTotal = number(line.total) ?? number(line.lineTotal) ?? number(line.amount);
    const sku = text(line.itemCode) ?? text(line.itemId);
    const delayedQuantity = number(projection?.delayedQuantity) ?? number(line.delayedQuantity);
    return {
      id,
      label: text(line.description) ?? text(line.itemId) ?? `行 ${index + 1}`,
      reference: text(line.lineNumber) ?? text(line.itemId) ?? "未记录编号",
      ...(sku === undefined ? {} : { sku }),
      category: text(line.category) ?? text(line.itemCategory),
      uom: text(line.uom),
      orderedQty,
      confirmedQty,
      remainderQty: confirmedQty === undefined || orderedQty === undefined ? undefined : Math.max(0, orderedQty - confirmedQty),
      shippedQty: number(projection?.shippedQty),
      receivedQty: number(projection?.receivedQty),
      unitPrice,
      tax,
      total: persistedTotal ?? (orderedQty !== undefined && unitPrice !== undefined ? orderedQty * unitPrice : undefined),
      status: text(line.status) ?? text(projection?.status),
      ...(delayedQuantity === undefined ? {} : { delayedQuantity }),
      currency: text(line.currency) ?? text(input.po.currency),
      requestedAt: text(line.requestedAt) ?? text(line.promisedAt),
      confirmedPromisedAt: text(confirmation?.promisedAt),
      quantityVariance,
      unitPriceVariance,
      promisedAtVarianceDays,
      varianceKnown,
      hasVariance: [quantityVariance, unitPriceVariance, promisedAtVarianceDays]
        .some((value) => value !== undefined && value !== 0),
    };
  });
}

export type PoDetailShortfallLine = {
  poLineId: string;
  label: string;
  uom: string;
  orderedQty: number;
  confirmedQty: number;
  remainderQty: number;
};

export type PoDetailShortfallSummary = {
  lines: PoDetailShortfallLine[];
  totalOrderedQty: number;
  totalConfirmedQty: number;
  totalRemainderQty: number;
  hasShortfall: boolean;
};

/**
 * Derives the short-confirmation closure quantity from persisted PO lines and
 * confirmation facts. Missing confirmation quantities stay out of the
 * calculation; they are not treated as zero.
 */
export function buildPoDetailShortfallSummary(input: {
  po: PoDetailRecord;
  lines: PoDetailRecord[];
  quantityProjections: PoDetailRecord[];
  confirmationLines: PoDetailRecord[];
}): PoDetailShortfallSummary {
  const itemRows = buildPoDetailItemRows(input);
  const lines = itemRows.flatMap((row) => {
    if (row.confirmedQty === undefined || row.orderedQty === undefined) return [];
    const remainderQty = Math.max(0, row.orderedQty - row.confirmedQty);
    if (remainderQty === 0) return [];
    return [{
      poLineId: row.id,
      label: row.label,
      uom: row.uom ?? "",
      orderedQty: row.orderedQty,
      confirmedQty: row.confirmedQty,
      remainderQty,
    }];
  });
  return {
    lines,
    totalOrderedQty: lines.reduce((sum, line) => sum + line.orderedQty, 0),
    totalConfirmedQty: lines.reduce((sum, line) => sum + line.confirmedQty, 0),
    totalRemainderQty: lines.reduce((sum, line) => sum + line.remainderQty, 0),
    hasShortfall: lines.some((line) => line.remainderQty > 0),
  };
}

/**
 * Keeps the destructive approval label exact without adding quantities from
 * unlike units. The per-line preview remains the authoritative detail.
 */
export function poDetailShortfallApprovalLabel(summary: PoDetailShortfallSummary): string {
  if (!summary.hasShortfall || summary.lines.length === 0) return "批准差异并继续";
  if (summary.lines.length === 1) {
    const line = summary.lines[0]!;
    return `批准短交并关闭剩余 ${line.remainderQty}${line.uom ? ` ${line.uom}` : ""}`;
  }
  const units = new Set(summary.lines.map((line) => line.uom).filter(Boolean));
  if (units.size === 1) {
    return `批准短交并关闭剩余 ${summary.totalRemainderQty} ${[...units][0]}`;
  }
  return `批准短交并关闭 ${summary.lines.length} 行剩余量`;
}

export function sortPoDetailCommunications(items: PoDetailRecord[]): PoDetailRecord[] {
  return [...items].sort((left, right) => String(right.receivedAt ?? right.occurredAt ?? right.createdAt ?? "")
    .localeCompare(String(left.receivedAt ?? left.occurredAt ?? left.createdAt ?? "")));
}

export type PoConfirmationCommunicationPreview = {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  body: string;
  messageId?: string;
};

export type PoConfirmationClarificationPlan = {
  targeted: boolean;
  label: string;
  description: string;
  reason: string;
  missingFields: SupplierReplyField[];
  knownFields: SupplierReplyField[];
};

const supplierReplyFieldLabels: Record<SupplierReplyField, string> = {
  quantity: "确认数量",
  unit_price: "确认单价",
  promised_date: "承诺交期",
};

/**
 * Turns a deterministic reply analysis into a supplier clarification request.
 * It only becomes targeted when at least one reliable fact exists and one or
 * two fields remain missing. The plan is still a draft instruction: it never
 * saves a confirmation or treats the PO baseline as a supplier fact.
 */
export function buildPoConfirmationClarificationPlan(
  analysis: SupplierReplyAnalysis | null | undefined,
): PoConfirmationClarificationPlan {
  const generic: PoConfirmationClarificationPlan = {
    targeted: false,
    label: "再次催确认",
    description: "请供应商回复全部 PO 行的数量、价格和承诺交期。",
    reason: "请再次确认采购订单全部行的数量、价格和承诺交期",
    missingFields: [],
    knownFields: [],
  };
  if (!analysis) return generic;

  const known = new Set<SupplierReplyField>();
  for (const line of analysis.lineSuggestions) {
    if (line.quantity?.confidence === "high") known.add("quantity");
    if (line.unitPrice?.confidence === "high") known.add("unit_price");
    if (line.promisedDate?.confidence === "high") known.add("promised_date");
  }
  const missingFields = [...new Set(analysis.missingFields)];
  const knownFields = (["quantity", "unit_price", "promised_date"] as const).filter((field) => known.has(field));
  if (analysis.reliableSuggestionCount === 0 || knownFields.length === 0 || missingFields.length === 0 || missingFields.length >= 3) {
    return generic;
  }

  const missingLabel = missingFields.map((field) => supplierReplyFieldLabels[field]).join("、");
  const knownLabel = knownFields.map((field) => supplierReplyFieldLabels[field]).join("、");
  return {
    targeted: true,
    label: missingFields.length === 1 ? `补充${missingLabel}` : "补充缺失确认字段",
    description: `最新真实回复已明确${knownLabel}，仍缺少${missingLabel}；草稿只突出缺失字段，并保留完整结构化确认块供供应商核对。`,
    reason: `我们已收到您关于${knownLabel}的回复。为完成采购订单确认，请在下方结构化确认块中补充${missingLabel}；其他字段请保留以便完整核对。`,
    missingFields,
    knownFields,
  };
}

export type PoConfirmationBaselineLine = {
  poLineId: string;
  orderedQty: number;
  poUnitPrice: number | null;
  requestedAt: string | null;
};

export type PoConfirmationBaselineValues = {
  quantities: Record<string, string>;
  unitPrices: Record<string, string>;
  promisedDates: Record<string, string>;
};

export type PoConfirmationVariancePreviewLine = PoConfirmationBaselineLine & {
  label: string;
  uom: string;
  currency: string;
};

export type PoConfirmationVariancePreviewRow = {
  poLineId: string;
  label: string;
  uom: string;
  currency: string;
  complete: boolean;
  comparisonComplete: boolean;
  missingFields: Array<"quantity" | "unitPrice" | "promisedAt">;
  orderedQty: number;
  confirmedQty: number | null;
  quantityVariance: number | null;
  poUnitPrice: number | null;
  confirmedUnitPrice: number | null;
  unitPriceVariance: number | null;
  unitPriceVariancePercent: number | null;
  requestedDate: string | null;
  promisedDate: string | null;
  promisedAtVarianceDays: number | null;
  hasVariance: boolean;
  requiresApproval: boolean | null;
};

export type PoConfirmationVariancePreview = {
  rows: PoConfirmationVariancePreviewRow[];
  totalLineCount: number;
  completeLineCount: number;
  varianceLineCount: number;
  approvalLineCount: number;
  comparisonUnknownLineCount: number;
  allComplete: boolean;
  wouldCreateApproval: boolean | null;
  wouldDirectlyConfirm: boolean;
};

/** Selects only a communication already admitted by the PO-scoped API contract. */
export function selectPoConfirmationCommunication(
  communications: PoConfirmationCommunicationPreview[],
  selectedId: string,
): PoConfirmationCommunicationPreview | undefined {
  if (!selectedId) return undefined;
  return communications.find((communication) => communication.id === selectedId);
}

/**
 * Converts immutable PO values into explicit, editable form input values.
 * Missing prices and dates remain missing; no supplier fact is inferred.
 */
export function buildPoConfirmationBaselineValues(
  lines: PoConfirmationBaselineLine[],
  timeZone: string,
): PoConfirmationBaselineValues {
  const quantities: Record<string, string> = {};
  const unitPrices: Record<string, string> = {};
  const promisedDates: Record<string, string> = {};
  for (const line of lines) {
    quantities[line.poLineId] = String(line.orderedQty);
    if (line.poUnitPrice !== null && Number.isFinite(line.poUnitPrice)) {
      unitPrices[line.poLineId] = String(line.poUnitPrice);
    }
    if (!line.requestedAt) continue;
    const requestedAt = new Date(line.requestedAt);
    if (Number.isNaN(requestedAt.getTime())) continue;
    const calendarDate = procurementCalendarDate(requestedAt, timeZone);
    if (calendarDate) promisedDates[line.poLineId] = calendarDate;
  }
  return { quantities, unitPrices, promisedDates };
}

/** Fills only blank fields so an operator's already-entered variance is never overwritten. */
export function fillBlankPoConfirmationValues(
  current: Record<string, string>,
  baseline: Record<string, string>,
): Record<string, string> {
  const next = { ...current };
  for (const [key, value] of Object.entries(baseline)) {
    if (!next[key]?.trim()) next[key] = value;
  }
  return next;
}

/**
 * Builds a read-only preflight from operator input and immutable PO values.
 * Approval mirrors executeRecordConfirmation: any quantity/price change, or a
 * promised-date delay greater than two days, requires approval. Missing input
 * and missing PO baselines stay unknown instead of being coerced to zero.
 */
export function buildPoConfirmationVariancePreview(input: {
  lines: PoConfirmationVariancePreviewLine[];
  quantities: Record<string, string>;
  unitPrices: Record<string, string>;
  promisedDates: Record<string, string>;
  timeZone: string;
}): PoConfirmationVariancePreview {
  const rows = input.lines.map((line): PoConfirmationVariancePreviewRow => {
    const confirmedQty = confirmationNumber(input.quantities[line.poLineId], (value) => value > 0);
    const confirmedUnitPrice = confirmationNumber(input.unitPrices[line.poLineId], (value) => value >= 0);
    const promisedDate = confirmationCalendarDate(input.promisedDates[line.poLineId]);
    const missingFields: PoConfirmationVariancePreviewRow["missingFields"] = [];
    if (confirmedQty === null) missingFields.push("quantity");
    if (confirmedUnitPrice === null) missingFields.push("unitPrice");
    if (promisedDate === null) missingFields.push("promisedAt");

    const requestedAt = line.requestedAt ? new Date(line.requestedAt) : null;
    const requestedAtValid = requestedAt !== null && !Number.isNaN(requestedAt.getTime());
    const requestedDate = requestedAtValid ? procurementCalendarDate(requestedAt, input.timeZone) || null : null;
    const poUnitPrice = line.poUnitPrice !== null && Number.isFinite(line.poUnitPrice) ? line.poUnitPrice : null;
    const variance = evaluateSupplierConfirmationVariance({
      orderedQty: line.orderedQty,
      confirmedQty,
      poUnitPrice,
      confirmedUnitPrice,
      requestedAt: line.requestedAt,
      promisedAt: promisedDate,
    });
    const quantityVariance = variance.quantityVariance ?? null;
    const unitPriceVariance = variance.unitPriceVariance ?? null;
    const unitPriceVariancePercent = unitPriceVariance === null || poUnitPrice === null || poUnitPrice === 0
      ? null
      : (unitPriceVariance / poUnitPrice) * 100;
    const promisedAtVarianceDays = variance.promisedAtVarianceDays ?? null;
    const complete = missingFields.length === 0;
    const comparisonComplete = complete && variance.comparisonComplete;
    const hasVariance = variance.hasVariance;
    const requiresApproval = !complete
      ? null
      : variance.requiresApproval
        ? true
        : comparisonComplete
          ? false
          : null;

    return {
      poLineId: line.poLineId,
      label: line.label,
      uom: line.uom,
      currency: line.currency,
      complete,
      comparisonComplete,
      missingFields,
      orderedQty: line.orderedQty,
      confirmedQty,
      quantityVariance,
      poUnitPrice,
      confirmedUnitPrice,
      unitPriceVariance,
      unitPriceVariancePercent,
      requestedDate,
      promisedDate,
      promisedAtVarianceDays,
      hasVariance,
      requiresApproval,
    };
  });
  const completeLineCount = rows.filter((row) => row.complete).length;
  const approvalLineCount = rows.filter((row) => row.requiresApproval === true).length;
  const comparisonUnknownLineCount = rows.filter((row) => row.complete && row.requiresApproval === null).length;
  const allComplete = rows.length > 0 && completeLineCount === rows.length;
  const wouldCreateApproval = !allComplete
    ? null
    : approvalLineCount > 0
      ? true
      : comparisonUnknownLineCount > 0
        ? null
        : false;
  return {
    rows,
    totalLineCount: rows.length,
    completeLineCount,
    varianceLineCount: rows.filter((row) => row.hasVariance).length,
    approvalLineCount,
    comparisonUnknownLineCount,
    allComplete,
    wouldCreateApproval,
    wouldDirectlyConfirm: allComplete && wouldCreateApproval === false,
  };
}

function confirmationNumber(raw: string | undefined, valid: (value: number) => boolean): number | null {
  if (raw === undefined || !raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && valid(value) ? value : null;
}

function confirmationCalendarDate(raw: string | undefined): string | null {
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? raw
    : null;
}

/** Keeps business kind from the API collection; timestamps are display data. */
export function buildPoDetailFulfilmentEvidence(input: {
  shipments: PoDetailRecord[];
  receipts: PoDetailRecord[];
}): Array<{ document: PoDetailRecord; kind: "shipment" | "receipt" }> {
  return [
    ...input.shipments.map((document) => ({ document, kind: "shipment" as const })),
    ...input.receipts.map((document) => ({ document, kind: "receipt" as const })),
  ];
}

export function poDetailMatchedSlaRules(stages: Array<{ id?: unknown; label?: unknown; sla?: PoDetailRecord | null }>): Array<{
  stage: string;
  ruleId: string;
  policyVersion?: number;
  status?: string;
}> {
  return stages.flatMap((stage) => {
    const ruleId = text(stage.sla?.ruleId);
    if (!ruleId) return [];
    return [{
      stage: text(stage.label) ?? text(stage.id) ?? "未命名阶段",
      ruleId,
      policyVersion: number(stage.sla?.policyVersion),
      status: text(stage.sla?.status),
    }];
  });
}

export type PoDetailContextRenderState = "loading" | "error" | "unavailable" | "ready";

/** Prevents a failed or not-yet-loaded context request from rendering false empty business facts. */
export function poDetailContextRenderState(input: {
  hasDetail: boolean;
  loading: boolean;
  error: string | null;
}): PoDetailContextRenderState {
  if (input.hasDetail) return "ready";
  if (input.loading) return "loading";
  if (input.error) return "error";
  return "unavailable";
}
