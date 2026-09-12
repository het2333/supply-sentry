import assert from "node:assert/strict";
import test from "node:test";
import * as procurementUiState from "../../console/features/procurement/procurement-ui-state.js";
import {
  importDocumentProcessingView,
  poSendActionAvailability,
  routeWorkbenchViewState,
} from "../../console/features/procurement/procurement-ui-state.js";

test("route workbench distinguishes a failed read from a real empty portfolio", () => {
  assert.equal(
    routeWorkbenchViewState({
      loading: false,
      hasPortfolio: false,
      error: "请求失败",
    }),
    "error",
  );
  assert.equal(
    routeWorkbenchViewState({
      loading: false,
      hasPortfolio: true,
      error: null,
    }),
    "content",
  );
  assert.equal(
    routeWorkbenchViewState({
      loading: true,
      hasPortfolio: false,
      error: null,
    }),
    "loading",
  );
});

test("import document processing states remain explicit and fail closed", () => {
  assert.deepEqual(importDocumentProcessingView("queued"), {
    label: "等待解析",
    tone: "amber",
    safe: false,
  });
  assert.deepEqual(importDocumentProcessingView("parsed"), {
    label: "解析完成",
    tone: "green",
    safe: true,
  });
  assert.deepEqual(importDocumentProcessingView("parse_failed"), {
    label: "解析失败",
    tone: "red",
    safe: false,
  });
  assert.deepEqual(importDocumentProcessingView("future_state"), {
    label: "状态待核验",
    tone: "slate",
    safe: false,
  });
});

test("PO send action fails closed until the API proves every prerequisite ready", () => {
  assert.deepEqual(poSendActionAvailability(undefined), {
    ready: false,
    code: "readiness_unavailable",
    message: "暂时无法验证发送前置条件，请刷新后重试。",
  });
  assert.deepEqual(
    poSendActionAvailability({
      ready: false,
      code: "communication_identity_missing",
      message: "尚未配置供应商可见的采购专业联系人，不能发送采购订单。",
      target: "communication-identity",
    }),
    {
      ready: false,
      code: "communication_identity_missing",
      message: "尚未配置供应商可见的采购专业联系人，不能发送采购订单。",
      target: "communication-identity",
    },
  );
});

test("SLA evaluation evidence is normalized without inventing missing business facts", () => {
  const helper = (procurementUiState as unknown as Record<string, unknown>)[
    "slaEvaluationEvidenceView"
  ];
  assert.equal(typeof helper, "function");
  const view = (
    helper as (input: Record<string, unknown>) => Record<string, any>
  )({
    policyId: "policy:v1",
    policyVersion: 3,
    ruleId: "commitment-default",
    stage: "supplier_commitment",
    evidence: {
      ruleName: "供应商确认期限",
      deadlineBasis: "stage_entry",
      calendarMode: "tenant_working_days",
      calendarTimeZone: "Asia/Shanghai",
      calendarWorkingDays: [1, 2, 3, 4, 5],
      calendarPreferenceVersion: 4,
      calendarInheritedDefault: false,
      basisAt: "2026-08-20T00:00:00.000Z",
      basisSource: "procurement_po_stage_events:stage_entered",
      route: "import",
      risk: "high",
      stageEntryEvent: {
        eventId: "po-stage-event:1",
        eventType: "stage_entered",
        occurredAt: "2026-08-20T00:00:00.000Z",
        sourceKind: "outbox",
        sourceId: "outbox:1",
      },
      riskFactors: [
        {
          code: "late-history",
          label: "历史延期",
          score: 30,
          evidence: "近 90 天延期 2 次",
        },
      ],
    },
  });
  assert.deepEqual(view, {
    policyId: "policy:v1",
    policyVersion: 3,
    ruleId: "commitment-default",
    ruleName: "供应商确认期限",
    stage: "supplier_commitment",
    deadlineBasis: "stage_entry",
    calendarMode: "tenant_working_days",
    calendarTimeZone: "Asia/Shanghai",
    calendarWorkingDays: [1, 2, 3, 4, 5],
    calendarPreferenceVersion: 4,
    calendarInheritedDefault: false,
    basisAt: "2026-08-20T00:00:00.000Z",
    basisSource: "procurement_po_stage_events:stage_entered",
    route: "import",
    risk: "high",
    reason: null,
    stageEntryEvent: {
      eventId: "po-stage-event:1",
      eventType: "stage_entered",
      occurredAt: "2026-08-20T00:00:00.000Z",
      sourceKind: "outbox",
      sourceId: "outbox:1",
    },
    riskFactors: [
      {
        code: "late-history",
        label: "历史延期",
        score: 30,
        evidence: "近 90 天延期 2 次",
      },
    ],
  });

  const empty = (
    helper as (input: Record<string, unknown>) => Record<string, any>
  )({
    policyId: "policy:v1",
    policyVersion: 3,
    ruleId: null,
    stage: "po_sent",
    evidence: null,
  });
  assert.equal(empty["basisAt"], null);
  assert.equal(empty["calendarMode"], null);
  assert.deepEqual(empty["calendarWorkingDays"], []);
  assert.equal(empty["stageEntryEvent"], null);
  assert.deepEqual(empty["riskFactors"], []);
});
