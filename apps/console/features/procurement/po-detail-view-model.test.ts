import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
} from "./po-detail-view-model";

describe("PO detail six-tab view model", () => {
  it("adds Navisight timeline presentation without advancing persisted stages", () => {
    assert.deepEqual(poDetailStageTimelineRows([
      { id: "po_sent", state: "completed" as const },
      { id: "supplier_commitment", state: "active" as const },
      { id: "fulfilment_production", state: "pending" as const },
    ]), [
      { id: "po_sent", state: "completed", ordinal: 1, stateLabel: "Completed", connector: "completed" },
      { id: "supplier_commitment", state: "active", ordinal: 2, stateLabel: "In progress", connector: "pending" },
      { id: "fulfilment_production", state: "pending", ordinal: 3, stateLabel: "Pending", connector: "none" },
    ]);
  });

  it("joins PO lines with persisted confirmation and delivery facts without fabricating missing values", () => {
    const rows = buildPoDetailItemRows({
      po: { currency: "CNY" },
      lines: [
        { id: "line:10", lineNumber: "10", itemId: "PV-30", description: "气动阀", uom: "EA", orderedQty: 100, unitPrice: 88, requestedAt: "2026-09-15T00:00:00.000Z" },
        { id: "line:20", lineNumber: "20", itemId: "SEAL", uom: "EA", orderedQty: 20, unitPrice: 3 },
      ],
      quantityProjections: [{ poLineId: "line:10", orderedQty: 100, confirmedQty: 90, shippedQty: 40, receivedQty: 15 }],
      confirmationLines: [{ poLineId: "line:10", confirmedQty: 90, quantityVariance: -10, unitPriceVariance: 2, promisedAt: "2026-09-18T00:00:00.000Z", promisedAtVarianceDays: 3 }],
    });

    assert.deepEqual(rows[0], {
      id: "line:10", label: "气动阀", reference: "10", sku: "PV-30", uom: "EA",
      category: undefined,
      orderedQty: 100, confirmedQty: 90, remainderQty: 10, shippedQty: 40, receivedQty: 15,
      unitPrice: 88, tax: undefined, total: 8800, status: undefined,
      currency: "CNY", requestedAt: "2026-09-15T00:00:00.000Z",
      confirmedPromisedAt: "2026-09-18T00:00:00.000Z", quantityVariance: -10,
      unitPriceVariance: 2, promisedAtVarianceDays: 3, varianceKnown: true, hasVariance: true,
    });
    assert.equal(rows[1]?.confirmedQty, undefined);
    assert.equal(rows[1]?.shippedQty, undefined);
    assert.equal(rows[1]?.receivedQty, undefined);
    assert.equal(rows[1]?.varianceKnown, false);
    assert.equal(rows[1]?.hasVariance, false);
  });

  it("keeps an absent ordered quantity unknown while projecting the fixed Items columns", () => {
    const [row] = buildPoDetailItemRows({
      po: { currency: "USD" },
      lines: [{ id: "line:unknown", description: "Control board", category: "Electronics", uom: "EA", unitPrice: 42, taxRate: 0.13, status: "open" }],
      quantityProjections: [],
      confirmationLines: [],
    });
    assert.equal(row?.orderedQty, undefined);
    assert.equal(row?.total, undefined);
    assert.equal(row?.category, "Electronics");
    assert.equal(row?.tax, 0.13);
    assert.equal(row?.status, "open");
  });

  it("distinguishes explicit zero variances from missing supplier-confirmation facts", () => {
    const rows = buildPoDetailItemRows({
      po: {},
      lines: [{ id: "line:10", orderedQty: 5 }],
      quantityProjections: [],
      confirmationLines: [{ poLineId: "line:10", quantityVariance: 0, unitPriceVariance: 0, promisedAtVarianceDays: 0 }],
    });
    assert.equal(rows[0]?.varianceKnown, true);
    assert.equal(rows[0]?.hasVariance, false);
    assert.equal(rows[0]?.promisedAtVarianceDays, 0);
  });

  it("derives each confirmed line remainder without treating missing confirmation as zero", () => {
    const summary = buildPoDetailShortfallSummary({
      po: {},
      lines: [
        { id: "line:10", description: "阀门", uom: "EA", orderedQty: 100 },
        { id: "line:20", description: "垫片", uom: "EA", orderedQty: 20 },
      ],
      quantityProjections: [{ poLineId: "line:10", orderedQty: 100, confirmedQty: 80 }],
      confirmationLines: [],
    });
    assert.deepEqual(summary.lines, [{ poLineId: "line:10", label: "阀门", uom: "EA", orderedQty: 100, confirmedQty: 80, remainderQty: 20 }]);
    assert.equal(summary.totalRemainderQty, 20);
    assert.equal(summary.hasShortfall, true);
  });

  it("never adds shortfall quantities across unlike units in the approval label", () => {
    const summary = buildPoDetailShortfallSummary({
      po: {},
      lines: [
        { id: "line:ea", description: "阀门", uom: "EA", orderedQty: 10 },
        { id: "line:kg", description: "粉末", uom: "KG", orderedQty: 20 },
        { id: "line:full", description: "垫片", uom: "EA", orderedQty: 5 },
      ],
      quantityProjections: [],
      confirmationLines: [
        { poLineId: "line:ea", confirmedQty: 8 },
        { poLineId: "line:kg", confirmedQty: 15 },
        { poLineId: "line:full", confirmedQty: 5 },
      ],
    });
    assert.deepEqual(summary.lines.map((line) => line.poLineId), ["line:ea", "line:kg"]);
    assert.equal(poDetailShortfallApprovalLabel(summary), "批准短交并关闭 2 行剩余量");
  });

  it("orders communication by persisted occurrence time without mutating the API array", () => {
    const source = [
      { id: "old", occurredAt: "2026-08-20T08:00:00.000Z" },
      { id: "new", receivedAt: "2026-08-21T08:00:00.000Z" },
    ];
    assert.deepEqual(sortPoDetailCommunications(source).map((item) => item.id), ["new", "old"]);
    assert.deepEqual(source.map((item) => item.id), ["old", "new"]);
  });

  it("selects the exact PO-scoped inbound communication for a read-only preview", () => {
    const communications = [
      { id: "communication:1", subject: "Re: P00021", from: "supplier@example.com", receivedAt: "2026-08-30T08:00:00.000Z", body: "只能交一半", messageId: "<reply-1@example.com>" },
      { id: "communication:2", subject: "Re: P00021", from: "supplier@example.com", receivedAt: "2026-08-30T09:00:00.000Z", body: "更新交期" },
    ];
    assert.equal(selectPoConfirmationCommunication(communications, "communication:2")?.body, "更新交期");
    assert.equal(selectPoConfirmationCommunication(communications, "communication:missing"), undefined);
    assert.equal(selectPoConfirmationCommunication(communications, ""), undefined);
  });

  it("turns a partial real reply into a targeted missing-price clarification", () => {
    const plan = buildPoConfirmationClarificationPlan({
      strategy: "deterministic_v1",
      intent: "partial_confirmation",
      analyzedText: "只能交一半，交期改为 8 月 10 日",
      quotedSectionRemoved: true,
      lineSuggestions: [{
        poLineId: "line:10",
        quantity: { value: 150, confidence: "high", raw: "一半", evidence: "只能交一半", rationale: "单行 PO" },
        promisedDate: { value: "2026-08-10", confidence: "high", raw: "8 月 10 日", evidence: "交期改为 8 月 10 日", rationale: "明确月日" },
      }],
      evidence: [], conflicts: [], missingFields: ["unit_price"], reliableSuggestionCount: 2, requiresHumanReview: true,
    });
    assert.equal(plan.targeted, true);
    assert.equal(plan.label, "补充确认单价");
    assert.deepEqual(plan.missingFields, ["unit_price"]);
    assert.deepEqual(plan.knownFields, ["quantity", "promised_date"]);
    assert.match(plan.description, /已明确确认数量、承诺交期/);
    assert.match(plan.reason, /补充确认单价/);
    assert.doesNotMatch(plan.reason, /确认确认/);
  });

  it("keeps the generic confirmation follow-up when no reliable supplier fact exists", () => {
    const plan = buildPoConfirmationClarificationPlan({
      strategy: "deterministic_v1", intent: "other", analyzedText: "请再看看", quotedSectionRemoved: false,
      lineSuggestions: [{ poLineId: "line:10" }], evidence: [], conflicts: [],
      missingFields: ["quantity", "unit_price", "promised_date"], reliableSuggestionCount: 0, requiresHumanReview: true,
    });
    assert.equal(plan.targeted, false);
    assert.equal(plan.label, "再次催确认");
    assert.deepEqual(plan.missingFields, []);
  });

  it("builds explicit PO baseline inputs using the tenant calendar date without inventing missing facts", () => {
    assert.deepEqual(buildPoConfirmationBaselineValues([
      { poLineId: "line:10", orderedQty: 300, poUnitPrice: 80, requestedAt: "2026-09-14T16:30:00.000Z" },
      { poLineId: "line:20", orderedQty: 12, poUnitPrice: null, requestedAt: null },
      { poLineId: "line:30", orderedQty: 5, poUnitPrice: 0, requestedAt: "not-a-date" },
    ], "Asia/Shanghai"), {
      quantities: { "line:10": "300", "line:20": "12", "line:30": "5" },
      unitPrices: { "line:10": "80", "line:30": "0" },
      promisedDates: { "line:10": "2026-09-15" },
    });
  });

  it("fills only blank confirmation fields and preserves an operator-entered variance", () => {
    assert.deepEqual(fillBlankPoConfirmationValues(
      { "line:10": "150", "line:20": "" },
      { "line:10": "300", "line:20": "12", "line:30": "5" },
    ), { "line:10": "150", "line:20": "12", "line:30": "5" });
  });

  it("previews a supplier short-confirmation without treating unchanged price as a variance", () => {
    const preview = buildPoConfirmationVariancePreview({
      lines: [{ poLineId: "line:10", label: "过滤器 FL-40", uom: "EA", currency: "USD", orderedQty: 300, poUnitPrice: 80, requestedAt: "2026-09-15T00:00:00.000Z" }],
      quantities: { "line:10": "150" },
      unitPrices: { "line:10": "80" },
      promisedDates: { "line:10": "2026-09-15" },
      timeZone: "Asia/Shanghai",
    });
    assert.equal(preview.rows[0]?.quantityVariance, -150);
    assert.equal(preview.rows[0]?.unitPriceVariance, 0);
    assert.equal(preview.rows[0]?.requiresApproval, true);
    assert.equal(preview.wouldCreateApproval, true);
  });

  it("uses the tenant calendar for the displayed PO date across a UTC boundary", () => {
    const preview = buildPoConfirmationVariancePreview({
      lines: [{ poLineId: "line:10", label: "气动阀", uom: "EA", currency: "CNY", orderedQty: 10, poUnitPrice: 5, requestedAt: "2026-09-14T16:30:00.000Z" }],
      quantities: { "line:10": "10" }, unitPrices: { "line:10": "5" }, promisedDates: { "line:10": "2026-09-15" },
      timeZone: "Asia/Shanghai",
    });
    assert.equal(preview.rows[0]?.requestedDate, "2026-09-15");
    assert.equal(preview.rows[0]?.promisedAtVarianceDays, 0);
    assert.equal(preview.wouldDirectlyConfirm, true);
  });

  it("mirrors the backend promise-delay threshold while keeping smaller date differences visible", () => {
    const base = [{ poLineId: "line:10", label: "气动阀", uom: "EA", currency: "CNY", orderedQty: 10, poUnitPrice: 5, requestedAt: "2026-09-15T00:00:00.000Z" }];
    const twoDays = buildPoConfirmationVariancePreview({ lines: base, quantities: { "line:10": "10" }, unitPrices: { "line:10": "5" }, promisedDates: { "line:10": "2026-09-17" }, timeZone: "Asia/Shanghai" });
    const threeDays = buildPoConfirmationVariancePreview({ lines: base, quantities: { "line:10": "10" }, unitPrices: { "line:10": "5" }, promisedDates: { "line:10": "2026-09-18" }, timeZone: "Asia/Shanghai" });
    assert.equal(twoDays.rows[0]?.promisedAtVarianceDays, 2);
    assert.equal(twoDays.rows[0]?.hasVariance, true);
    assert.equal(twoDays.rows[0]?.requiresApproval, false);
    assert.equal(threeDays.rows[0]?.promisedAtVarianceDays, 3);
    assert.equal(threeDays.rows[0]?.requiresApproval, true);
  });

  it("keeps unit-price comparison unknown when the PO baseline is absent", () => {
    const preview = buildPoConfirmationVariancePreview({
      lines: [{ poLineId: "line:10", label: "气动阀", uom: "EA", currency: "CNY", orderedQty: 10, poUnitPrice: null, requestedAt: "2026-09-15T00:00:00.000Z" }],
      quantities: { "line:10": "10" }, unitPrices: { "line:10": "5" }, promisedDates: { "line:10": "2026-09-15" },
      timeZone: "Asia/Shanghai",
    });
    assert.equal(preview.rows[0]?.complete, true);
    assert.equal(preview.rows[0]?.unitPriceVariance, null);
    assert.equal(preview.rows[0]?.requiresApproval, null);
    assert.equal(preview.wouldCreateApproval, null);
  });

  it("never coerces blank confirmation input into zero or a complete comparison", () => {
    const preview = buildPoConfirmationVariancePreview({
      lines: [{ poLineId: "line:10", label: "气动阀", uom: "EA", currency: "CNY", orderedQty: 10, poUnitPrice: 5, requestedAt: "2026-09-15T00:00:00.000Z" }],
      quantities: { "line:10": "" }, unitPrices: { "line:10": "" }, promisedDates: { "line:10": "" },
      timeZone: "Asia/Shanghai",
    });
    assert.equal(preview.rows[0]?.confirmedQty, null);
    assert.equal(preview.rows[0]?.quantityVariance, null);
    assert.deepEqual(preview.rows[0]?.missingFields, ["quantity", "unitPrice", "promisedAt"]);
    assert.equal(preview.allComplete, false);
    assert.equal(preview.wouldCreateApproval, null);
  });

  it("aggregates complete, variance, approval, and unknown multi-line results", () => {
    const preview = buildPoConfirmationVariancePreview({
      lines: [
        { poLineId: "line:10", label: "阀门", uom: "EA", currency: "CNY", orderedQty: 10, poUnitPrice: 5, requestedAt: "2026-09-15T00:00:00.000Z" },
        { poLineId: "line:20", label: "密封圈", uom: "EA", currency: "CNY", orderedQty: 20, poUnitPrice: null, requestedAt: "2026-09-15T00:00:00.000Z" },
      ],
      quantities: { "line:10": "8", "line:20": "20" }, unitPrices: { "line:10": "5", "line:20": "2" }, promisedDates: { "line:10": "2026-09-15", "line:20": "2026-09-15" },
      timeZone: "Asia/Shanghai",
    });
    assert.equal(preview.totalLineCount, 2);
    assert.equal(preview.completeLineCount, 2);
    assert.equal(preview.varianceLineCount, 1);
    assert.equal(preview.approvalLineCount, 1);
    assert.equal(preview.comparisonUnknownLineCount, 1);
    assert.equal(preview.wouldCreateApproval, true);
  });

  it("shows only SLA rules actually attached to persisted stage evaluations", () => {
    assert.deepEqual(poDetailMatchedSlaRules([
      { id: "po_sent", label: "PO Sent", sla: { ruleId: "rule:sent", policyVersion: 4, status: "running" } },
      { id: "supplier_commitment", label: "Supplier Commitment", sla: null },
    ]), [{ stage: "PO Sent", ruleId: "rule:sent", policyVersion: 4, status: "running" }]);
  });

  it("keeps receipt identity even when legacy receipt display timestamps are absent", () => {
    const receipt = { id: "receipt:legacy", receivedAt: undefined };
    assert.deepEqual(buildPoDetailFulfilmentEvidence({ shipments: [], receipts: [receipt] }), [
      { document: receipt, kind: "receipt" },
    ]);
  });

  it("never turns a missing or failed context request into a ready empty business view", () => {
    assert.equal(poDetailContextRenderState({ hasDetail: false, loading: true, error: null }), "loading");
    assert.equal(poDetailContextRenderState({ hasDetail: false, loading: false, error: "请求失败" }), "error");
    assert.equal(poDetailContextRenderState({ hasDetail: false, loading: false, error: null }), "unavailable");
    assert.equal(poDetailContextRenderState({ hasDetail: true, loading: false, error: "后台刷新失败" }), "ready");
  });
});
