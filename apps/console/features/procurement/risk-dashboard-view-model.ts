export type RiskTrendDirection = "up" | "down" | "flat" | "missing";

export type RiskMetricDelta = {
  text: string;
  direction: RiskTrendDirection;
  favorable: boolean | null;
};

export type CurrencyMetricDelta = RiskMetricDelta & {
  currency: string;
  absoluteDelta: number;
};

export type RiskScorePresentationInput = {
  riskPublicationState: "published" | "provisional" | "not_published" | "legacy";
  risk: "high" | "medium" | "low";
  riskScore: number;
  riskModel: {
    modelVersion?: "risk-model-v2" | "legacy-risk-v1";
    evidenceCoverage: number | null;
    totalScore: number | null;
    provisionalScore: number | null;
    provisionalBand: "high" | "medium" | "low" | null;
  };
  missingRiskComponents: readonly string[];
};

const riskLabels = { high: "高风险", medium: "中风险", low: "低风险" } as const;
const componentLabels: Record<string, string> = {
  supplierPerformance: "供应商绩效",
  deliveryDelay: "交付延误",
  poValue: "订单金额",
  productCriticality: "产品关键程度",
  complianceApproval: "合规与审批",
};

export function riskScorePresentation(input: RiskScorePresentationInput) {
  const missingLabel = input.missingRiskComponents.length
    ? input.missingRiskComponents.map((name) => componentLabels[name] ?? name).join("、")
    : null;
  if (input.riskPublicationState === "legacy" || input.riskModel.modelVersion === "legacy-risk-v1") return {
    label: `旧模型 · ${riskLabels[input.risk]}`,
    score: `${input.riskScore}/100`,
    stateLabel: "旧模型评分 · 无证据覆盖率",
    tone: "legacy",
    formalHighRisk: false,
    missingLabel,
  } as const;
  const coverage = `${Math.round((input.riskModel.evidenceCoverage ?? 0) * 100)}%`;
  if (input.riskPublicationState === "published" && input.riskModel.totalScore !== null) return {
    label: riskLabels[input.risk],
    score: `${input.riskModel.totalScore}/100`,
    stateLabel: `已发布 · 证据覆盖率 ${coverage}`,
    tone: input.risk,
    formalHighRisk: input.risk === "high",
    missingLabel,
  } as const;
  if (input.riskPublicationState === "provisional" && input.riskModel.provisionalScore !== null && input.riskModel.provisionalBand) return {
    label: `暂定 · ${riskLabels[input.riskModel.provisionalBand]}`,
    score: `${input.riskModel.provisionalScore}/100`,
    stateLabel: `暂定评分 · 证据覆盖率 ${coverage}`,
    tone: "provisional",
    formalHighRisk: false,
    missingLabel,
  } as const;
  return {
    label: "评分未发布",
    score: "—",
    stateLabel: `未发布 · 证据覆盖率 ${coverage}`,
    tone: "unpublished",
    formalHighRisk: false,
    missingLabel,
  } as const;
}

export function isHighRiskListItem(input: RiskScorePresentationInput): boolean {
  const presentation = riskScorePresentation(input);
  return presentation.formalHighRisk || (input.riskPublicationState === "legacy" && input.risk === "high");
}

/** Display the frozen supplier aggregate without borrowing one PO's publication state. */
export function supplierRiskPresentation(averageScore: number, purchaseOrders: number, items: readonly RiskScorePresentationInput[]) {
  const provisionalEvidence = items.length > 1 ? items.flatMap((item, itemIndex) => {
    const presentation = riskScorePresentation(item);
    return presentation.tone === "provisional" ? [{ itemIndex, score: presentation.score, stateLabel: presentation.stateLabel, missingLabel: presentation.missingLabel }] : [];
  }) : [];
  if (items.length === 1 && purchaseOrders === 1) {
    const presentation = riskScorePresentation(items[0]!);
    return { ...presentation, barScore: presentation.tone === "unpublished" ? null : averageScore, provisionalEvidence };
  }
  const unpublished = items.filter((item) => riskScorePresentation(item).tone === "unpublished").length;
  const missingDetails = Math.max(0, purchaseOrders - items.length);
  if (!items.length || unpublished || missingDetails) return {
    score: "—", stateLabel: "均分未发布", tone: "unpublished", barScore: null, provisionalEvidence,
    missingLabel: [unpublished ? `${unpublished} 张订单评分未发布` : null, missingDetails ? `缺少 ${missingDetails} 张订单评分明细` : null].filter(Boolean).join("；") || null,
  } as const;
  const provisional = items.some((item) => riskScorePresentation(item).tone === "provisional");
  const legacy = items.some((item) => riskScorePresentation(item).tone === "legacy");
  const tone = legacy ? "legacy" : provisional ? "provisional" : averageScore >= 70 ? "high" : averageScore >= 40 ? "medium" : "low";
  return {
    score: `${averageScore}/100`, barScore: averageScore, tone, provisionalEvidence,
    stateLabel: `${legacy ? "快照均分（含旧模型）" : provisional ? "暂定均分" : "已发布均分"} · ${purchaseOrders} 张订单`,
    missingLabel: provisional ? [...new Set(items.filter((item) => riskScorePresentation(item).tone === "provisional").flatMap((item) => item.missingRiskComponents))].map((name) => componentLabels[name] ?? name).join("、") || null : null,
  } as const;
}

export function riskMetricDelta(
  current: number,
  previous: number | undefined,
  options: { suffix?: string; increaseIsFavorable?: boolean } = {},
): RiskMetricDelta {
  if (previous === undefined) return { text: "无上一份快照", direction: "missing", favorable: null };
  const value = Math.round((current - previous) * 10) / 10;
  if (value === 0) return { text: "无变化", direction: "flat", favorable: null };
  const direction = value > 0 ? "up" : "down";
  const favorable = value > 0 ? Boolean(options.increaseIsFavorable) : !options.increaseIsFavorable;
  return {
    text: `${direction === "up" ? "↗" : "↘"} ${Math.abs(value)}${options.suffix ?? ""}`,
    direction,
    favorable,
  };
}

export function currencyMetricDeltas(
  current: Record<string, number>,
  previous: Record<string, number> | undefined,
): CurrencyMetricDelta[] {
  if (!previous) return [];
  const currencies = [...new Set([...Object.keys(current), ...Object.keys(previous)])].sort();
  return currencies.map((currency) => {
    const currentValue = current[currency] ?? 0;
    const previousValue = previous[currency] ?? 0;
    const delta = riskMetricDelta(currentValue, previousValue, { increaseIsFavorable: false });
    return { currency, absoluteDelta: Math.abs(Math.round((currentValue - previousValue) * 100) / 100), ...delta };
  });
}
