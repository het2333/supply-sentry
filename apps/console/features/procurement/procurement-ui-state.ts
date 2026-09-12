export type RouteWorkbenchViewState = "loading" | "error" | "content";

export function routeWorkbenchViewState(input: {
  loading: boolean;
  hasPortfolio: boolean;
  error: string | null;
}): RouteWorkbenchViewState {
  if (input.loading && !input.hasPortfolio) return "loading";
  if (input.error && !input.hasPortfolio) return "error";
  return "content";
}

export type ProcessingTone = "green" | "amber" | "red" | "slate";

export function importDocumentProcessingView(
  status: string | null | undefined,
): {
  label: string;
  tone: ProcessingTone;
  safe: boolean;
} {
  switch (status) {
    case "parsed":
      return { label: "解析完成", tone: "green", safe: true };
    case "queued":
    case "pending":
    case "processing":
    case "parsing":
      return { label: "等待解析", tone: "amber", safe: false };
    case "parse_failed":
    case "failed":
      return { label: "解析失败", tone: "red", safe: false };
    default:
      return { label: "状态待核验", tone: "slate", safe: false };
  }
}

export type PoSendActionReadiness = {
  ready: boolean;
  code: string;
  message: string;
  target?: "communication-identity" | "connector-email" | "documents";
};

export function poSendActionAvailability(
  readiness: PoSendActionReadiness | null | undefined,
): PoSendActionReadiness {
  return (
    readiness ?? {
      ready: false,
      code: "readiness_unavailable",
      message: "暂时无法验证发送前置条件，请刷新后重试。",
    }
  );
}

export type PoFollowupActionReadiness = {
  ready: boolean;
  code: string;
  message: string;
  target?: "communication-identity";
};

export function poFollowupActionAvailability(
  readiness: PoFollowupActionReadiness | null | undefined,
): PoFollowupActionReadiness {
  return (
    readiness ?? {
      ready: false,
      code: "readiness_unavailable",
      message: "暂时无法验证跟进草稿前置条件，请刷新后重试。",
    }
  );
}

export type SlaRiskFactorView = {
  code: string;
  label: string;
  score: number;
  evidence: string;
};

export type SlaStageEntryEvidenceView = {
  eventId: string;
  eventType: string;
  occurredAt: string;
  sourceKind: string;
  sourceId: string;
};

export type SlaEvaluationEvidenceView = {
  policyId: string;
  policyVersion: number | null;
  ruleId: string | null;
  ruleName: string | null;
  stage: string;
  deadlineBasis: string | null;
  calendarMode: string | null;
  calendarTimeZone: string | null;
  calendarWorkingDays: number[];
  calendarPreferenceVersion: number | null;
  calendarInheritedDefault: boolean | null;
  basisAt: string | null;
  basisSource: string | null;
  route: string | null;
  risk: string | null;
  reason: string | null;
  stageEntryEvent: SlaStageEntryEvidenceView | null;
  riskFactors: SlaRiskFactorView[];
};

export function slaEvaluationEvidenceView(input: {
  policyId: string;
  policyVersion: number | null;
  ruleId: string | null;
  stage: string;
  evidence?: unknown;
}): SlaEvaluationEvidenceView {
  const evidence = recordValue(input.evidence) ?? {};
  const stageEntry = recordValue(evidence["stageEntryEvent"]);
  const stageEntryEvent =
    stageEntry &&
    stringValue(stageEntry["eventId"]) &&
    stringValue(stageEntry["eventType"]) &&
    stringValue(stageEntry["occurredAt"]) &&
    stringValue(stageEntry["sourceKind"]) &&
    stringValue(stageEntry["sourceId"])
      ? {
          eventId: stringValue(stageEntry["eventId"])!,
          eventType: stringValue(stageEntry["eventType"])!,
          occurredAt: stringValue(stageEntry["occurredAt"])!,
          sourceKind: stringValue(stageEntry["sourceKind"])!,
          sourceId: stringValue(stageEntry["sourceId"])!,
        }
      : null;
  const riskFactors = Array.isArray(evidence["riskFactors"])
    ? evidence["riskFactors"].flatMap((value) => {
        const factor = recordValue(value);
        const code = stringValue(factor?.["code"]);
        const label = stringValue(factor?.["label"]);
        const score =
          typeof factor?.["score"] === "number" &&
          Number.isFinite(factor["score"])
            ? factor["score"]
            : null;
        const factorEvidence = stringValue(factor?.["evidence"]);
        return code && label && score !== null && factorEvidence
          ? [{ code, label, score, evidence: factorEvidence }]
          : [];
      })
    : [];
  return {
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    ruleId: input.ruleId,
    ruleName: stringValue(evidence["ruleName"]),
    stage: input.stage,
    deadlineBasis: stringValue(evidence["deadlineBasis"]),
    calendarMode: stringValue(evidence["calendarMode"]),
    calendarTimeZone: stringValue(evidence["calendarTimeZone"]),
    calendarWorkingDays: isoWorkingDays(evidence["calendarWorkingDays"]),
    calendarPreferenceVersion: finiteNumber(
      evidence["calendarPreferenceVersion"],
    ),
    calendarInheritedDefault: booleanValue(
      evidence["calendarInheritedDefault"],
    ),
    basisAt: stringValue(evidence["basisAt"]),
    basisSource: stringValue(evidence["basisSource"]),
    route: stringValue(evidence["route"]),
    risk: stringValue(evidence["risk"]),
    reason: stringValue(evidence["reason"]),
    stageEntryEvent,
    riskFactors,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isoWorkingDays(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (day): day is number => Number.isSafeInteger(day) && day >= 1 && day <= 7,
  );
}
