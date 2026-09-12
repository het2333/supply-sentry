import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateSupplierConfirmationVariance,
  SUPPLIER_CONFIRMATION_PROMISED_DELAY_APPROVAL_DAYS,
  supplierConfirmationPromisedVarianceDays,
} from "../src/procurement-confirmation.js";

describe("supplier confirmation variance contract", () => {
  it("keeps an unchanged complete confirmation approval-free", () => {
    assert.deepEqual(evaluateSupplierConfirmationVariance({
      orderedQty: 300,
      confirmedQty: 300,
      poUnitPrice: 80,
      confirmedUnitPrice: 80,
      requestedAt: "2026-09-15T00:00:00.000Z",
      promisedAt: "2026-09-15T00:00:00.000Z",
    }), {
      quantityVariance: 0,
      unitPriceVariance: 0,
      promisedAtVarianceDays: 0,
      comparisonComplete: true,
      hasVariance: false,
      requiresApproval: false,
      approvalReasons: [],
    });
  });

  it("requires approval for any quantity or unit-price change", () => {
    const result = evaluateSupplierConfirmationVariance({
      orderedQty: 300,
      confirmedQty: 150,
      poUnitPrice: 80,
      confirmedUnitPrice: 81,
    });
    assert.equal(result.quantityVariance, -150);
    assert.equal(result.unitPriceVariance, 1);
    assert.equal(result.requiresApproval, true);
    assert.deepEqual(result.approvalReasons, ["quantity", "unit_price"]);
  });

  it("keeps two delay days visible and requires approval from day three", () => {
    assert.equal(SUPPLIER_CONFIRMATION_PROMISED_DELAY_APPROVAL_DAYS, 2);
    const twoDays = evaluateSupplierConfirmationVariance({
      orderedQty: 10, confirmedQty: 10, poUnitPrice: 5, confirmedUnitPrice: 5,
      requestedAt: "2026-09-15T00:00:00.000Z", promisedAt: "2026-09-17T00:00:00.000Z",
    });
    const threeDays = evaluateSupplierConfirmationVariance({
      orderedQty: 10, confirmedQty: 10, poUnitPrice: 5, confirmedUnitPrice: 5,
      requestedAt: "2026-09-15T00:00:00.000Z", promisedAt: "2026-09-18T00:00:00.000Z",
    });
    assert.equal(twoDays.promisedAtVarianceDays, 2);
    assert.equal(twoDays.hasVariance, true);
    assert.equal(twoDays.requiresApproval, false);
    assert.equal(threeDays.promisedAtVarianceDays, 3);
    assert.equal(threeDays.requiresApproval, true);
    assert.deepEqual(threeDays.approvalReasons, ["promised_delay"]);
  });

  it("uses the same rounded timestamp semantics across a tenant calendar boundary", () => {
    assert.equal(supplierConfirmationPromisedVarianceDays(
      "2026-09-14T16:30:00.000Z",
      "2026-09-15T00:00:00.000Z",
    ), 0);
  });

  it("preserves unknown baselines and rejects invalid dates as comparisons", () => {
    const result = evaluateSupplierConfirmationVariance({
      orderedQty: 10,
      confirmedQty: 10,
      poUnitPrice: null,
      confirmedUnitPrice: 5,
      requestedAt: "invalid",
      promisedAt: "2026-09-15",
    });
    assert.equal(result.unitPriceVariance, undefined);
    assert.equal(result.promisedAtVarianceDays, undefined);
    assert.equal(result.comparisonComplete, false);
    assert.equal(result.requiresApproval, false);
  });
});
