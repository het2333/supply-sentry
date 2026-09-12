import assert from "node:assert/strict";
import { test } from "node:test";
import { currencyMetricDeltas, isHighRiskListItem, riskMetricDelta, riskScorePresentation, supplierRiskPresentation, type RiskScorePresentationInput } from "../features/procurement/risk-dashboard-view-model.js";

test("Risk Dashboard deltas use business direction instead of raw number color", () => {
  assert.deepEqual(riskMetricDelta(8, 10), { text: "↘ 2", direction: "down", favorable: true });
  assert.deepEqual(riskMetricDelta(12, 10), { text: "↗ 2", direction: "up", favorable: false });
  assert.deepEqual(riskMetricDelta(12, 10, { increaseIsFavorable: true }), { text: "↗ 2", direction: "up", favorable: true });
  assert.deepEqual(riskMetricDelta(10, 10), { text: "无变化", direction: "flat", favorable: null });
  assert.equal(riskMetricDelta(8.6, 10.7, { suffix: "%" }).text, "↘ 2.1%");
});

test("Risk Dashboard currency deltas preserve currencies and never invent FX totals", () => {
  assert.deepEqual(currencyMetricDeltas({ CNY: 800, USD: 120 }, { CNY: 1000, EUR: 50, USD: 100 }), [
    { currency: "CNY", absoluteDelta: 200, text: "↘ 200", direction: "down", favorable: true },
    { currency: "EUR", absoluteDelta: 50, text: "↘ 50", direction: "down", favorable: true },
    { currency: "USD", absoluteDelta: 20, text: "↗ 20", direction: "up", favorable: false },
  ]);
  assert.deepEqual(currencyMetricDeltas({ CNY: 800 }, undefined), []);
});

test("Risk Dashboard distinguishes published, provisional and unpublished V2 scores", () => {
  assert.deepEqual(riskScorePresentation({
    riskPublicationState: "published", risk: "high", riskScore: 75,
    riskModel: { evidenceCoverage: 1, totalScore: 75, provisionalScore: null, provisionalBand: null },
    missingRiskComponents: [],
  }), {
    label: "高风险", score: "75/100", stateLabel: "已发布 · 证据覆盖率 100%", tone: "high", formalHighRisk: true, missingLabel: null,
  });
  assert.deepEqual(riskScorePresentation({
    riskPublicationState: "provisional", risk: "medium", riskScore: 65,
    riskModel: { evidenceCoverage: 0.75, totalScore: null, provisionalScore: 65, provisionalBand: "medium" },
    missingRiskComponents: ["productCriticality", "complianceApproval"],
  }), {
    label: "暂定 · 中风险", score: "65/100", stateLabel: "暂定评分 · 证据覆盖率 75%", tone: "provisional", formalHighRisk: false, missingLabel: "产品关键程度、合规与审批",
  });
  assert.deepEqual(riskScorePresentation({
    riskPublicationState: "not_published", risk: "low", riskScore: 0,
    riskModel: { evidenceCoverage: 0.55, totalScore: null, provisionalScore: null, provisionalBand: null },
    missingRiskComponents: ["deliveryDelay", "productCriticality"],
  }), {
    label: "评分未发布", score: "—", stateLabel: "未发布 · 证据覆盖率 55%", tone: "unpublished", formalHighRisk: false, missingLabel: "交付延误、产品关键程度",
  });
});

test("Risk Dashboard renders a legacy score without claiming V2 evidence or formal risk", () => {
  const legacyLow = {
    riskPublicationState: "legacy", risk: "low", riskScore: 10,
    riskModel: { modelVersion: "legacy-risk-v1", evidenceCoverage: null, totalScore: null, provisionalScore: null, provisionalBand: null },
    missingRiskComponents: [],
  } as const;
  assert.deepEqual(riskScorePresentation(legacyLow), {
    label: "旧模型 · 低风险", score: "10/100", stateLabel: "旧模型评分 · 无证据覆盖率", tone: "legacy", formalHighRisk: false, missingLabel: null,
  });
  assert.equal(isHighRiskListItem(legacyLow), false, "legacy low scores must not enter the high-risk table");
  assert.equal(isHighRiskListItem({ ...legacyLow, risk: "high", riskScore: 88 }), true, "legacy high scores remain visible in the immutable snapshot detail");
});

test("supplier provisional averages retain per-order coverage and missing evidence without inventing aggregate coverage", () => {
  const items: RiskScorePresentationInput[] = [
    { riskPublicationState: "published", risk: "high", riskScore: 85, riskModel: { evidenceCoverage: 1, totalScore: 85, provisionalScore: null, provisionalBand: null }, missingRiskComponents: [] },
    { riskPublicationState: "provisional", risk: "medium", riskScore: 65, riskModel: { evidenceCoverage: 0.75, totalScore: null, provisionalScore: 65, provisionalBand: "medium" }, missingRiskComponents: ["productCriticality", "complianceApproval"] },
  ];
  const presentation = supplierRiskPresentation(75, 2, items);
  assert.equal(presentation.score, "75/100");
  assert.equal(presentation.tone, "provisional");
  assert.equal(presentation.missingLabel, "产品关键程度、合规与审批");
  assert.deepEqual(presentation.provisionalEvidence, [{ itemIndex: 1, score: "65/100", stateLabel: "暂定评分 · 证据覆盖率 75%", missingLabel: "产品关键程度、合规与审批" }]);
  assert.doesNotMatch(presentation.stateLabel, /证据覆盖率/);
});
