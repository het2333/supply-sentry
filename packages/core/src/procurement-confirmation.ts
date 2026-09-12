/**
 * A supplier promise may move by at most this many rounded days without the
 * promise-date change alone requiring a human approval. Quantity and unit
 * price changes always require approval.
 */
export const SUPPLIER_CONFIRMATION_PROMISED_DELAY_APPROVAL_DAYS = 2;

export type SupplierConfirmationApprovalReason = "quantity" | "unit_price" | "promised_delay";

export type SupplierConfirmationVarianceInput = {
  orderedQty?: number | null;
  confirmedQty?: number | null;
  poUnitPrice?: number | null;
  confirmedUnitPrice?: number | null;
  requestedAt?: string | null;
  promisedAt?: string | null;
};

export type SupplierConfirmationVarianceEvaluation = {
  quantityVariance?: number;
  unitPriceVariance?: number;
  promisedAtVarianceDays?: number;
  comparisonComplete: boolean;
  hasVariance: boolean;
  requiresApproval: boolean;
  approvalReasons: SupplierConfirmationApprovalReason[];
};

/**
 * Single authoritative supplier-confirmation variance rule shared by the
 * write path and read-only Web preflight. The caller still owns validation;
 * unavailable or non-finite baselines remain unknown instead of becoming 0.
 */
export function evaluateSupplierConfirmationVariance(
  input: SupplierConfirmationVarianceInput,
): SupplierConfirmationVarianceEvaluation {
  const orderedQty = finiteNumber(input.orderedQty);
  const confirmedQty = finiteNumber(input.confirmedQty);
  const poUnitPrice = finiteNumber(input.poUnitPrice);
  const confirmedUnitPrice = finiteNumber(input.confirmedUnitPrice);
  const quantityVariance = orderedQty === undefined || confirmedQty === undefined
    ? undefined
    : confirmedQty - orderedQty;
  const unitPriceVariance = poUnitPrice === undefined || confirmedUnitPrice === undefined
    ? undefined
    : confirmedUnitPrice - poUnitPrice;
  const promisedAtVarianceDays = supplierConfirmationPromisedVarianceDays(
    input.requestedAt,
    input.promisedAt,
  );
  const promisedComparisonComplete = !input.promisedAt || promisedAtVarianceDays !== undefined;
  const comparisonComplete = quantityVariance !== undefined
    && unitPriceVariance !== undefined
    && promisedComparisonComplete;
  const approvalReasons: SupplierConfirmationApprovalReason[] = [];
  if (quantityVariance !== undefined && quantityVariance !== 0) approvalReasons.push("quantity");
  if (unitPriceVariance !== undefined && unitPriceVariance !== 0) approvalReasons.push("unit_price");
  if (promisedAtVarianceDays !== undefined
    && promisedAtVarianceDays > SUPPLIER_CONFIRMATION_PROMISED_DELAY_APPROVAL_DAYS) {
    approvalReasons.push("promised_delay");
  }
  return {
    ...(quantityVariance === undefined ? {} : { quantityVariance }),
    ...(unitPriceVariance === undefined ? {} : { unitPriceVariance }),
    ...(promisedAtVarianceDays === undefined ? {} : { promisedAtVarianceDays }),
    comparisonComplete,
    hasVariance: [quantityVariance, unitPriceVariance, promisedAtVarianceDays]
      .some((value) => value !== undefined && value !== 0),
    requiresApproval: approvalReasons.length > 0,
    approvalReasons,
  };
}

/** Mirrors the repository's rounded exact-timestamp day calculation. */
export function supplierConfirmationPromisedVarianceDays(
  requestedAt: string | null | undefined,
  promisedAt: string | null | undefined,
): number | undefined {
  if (!requestedAt || !promisedAt) return undefined;
  const requestedTime = Date.parse(requestedAt);
  const promisedTime = Date.parse(promisedAt);
  if (!Number.isFinite(requestedTime) || !Number.isFinite(promisedTime)) return undefined;
  return Math.round((promisedTime - requestedTime) / 86_400_000);
}

function finiteNumber(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
