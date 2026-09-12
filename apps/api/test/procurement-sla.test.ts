import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  PurchaseOrder,
  PurchaseOrderLine,
  Supplier,
} from "@readywork/core";
import { openPersistence } from "@readywork/persistence";
import type { Session } from "../src/auth.js";
import { ProcurementSlaAutomationWorker } from "../src/procurement-sla-automation.js";
import { handleProcurementSlaRequest } from "../src/procurement-sla.js";

const tenantId = "tenant:sla";
const manager: Session = {
  username: "manager",
  tenantId,
  humanId: "human:manager",
  name: "王经理",
  role: "采购经理",
  expiresAt: Date.now() + 60_000,
};
const buyer: Session = {
  username: "buyer",
  tenantId,
  humanId: "human:buyer",
  name: "李采购",
  role: "采购专员",
  expiresAt: Date.now() + 60_000,
};
const rule = {
  id: "commitment-default",
  name: "供应商确认期限",
  enabled: true,
  route: "all",
  stage: "supplier_commitment",
  risk: "all",
  deadlineBasis: "stage_entry",
  targetOffsetHours: 24,
  warningHours: 4,
  graceHours: 2,
  followupIntervalHours: 24,
  maxFollowups: 3,
  escalationRole: "采购经理",
  messageCategory: "acknowledgement_followup",
};

test("SLA 控制面：草稿、发布、版本冲突、规则命中、评估历史、权限和租户隔离", async () => {
  const store = openPersistence(":memory:", { tenantId });
  const at = "2026-08-20T00:00:00.000Z";
  const supplier: Supplier = {
    id: "supplier:sla",
    tenantId,
    sourceSystem: "odoo",
    externalId: "SUP-SLA",
    status: "active",
    createdAt: at,
    updatedAt: at,
    name: "真实供应商",
    contacts: [],
    currency: "CNY",
  };
  const po: PurchaseOrder = {
    id: "po:sla",
    tenantId,
    sourceSystem: "odoo",
    externalId: "P-SLA-001",
    status: "sent",
    createdAt: at,
    updatedAt: at,
    supplierId: supplier.id,
    currency: "CNY",
    orderedAt: at,
  };
  const line: PurchaseOrderLine = {
    id: "line:sla",
    poId: po.id,
    lineNumber: "10",
    itemId: "item:sla",
    description: "控制阀",
    uom: "EA",
    orderedQty: 1,
    unitPrice: 100,
    currency: "CNY",
    requestedAt: "2026-09-30T00:00:00.000Z",
  };
  store.procurement.saveDocument("supplier", supplier);
  store.procurement.saveDocument("purchase_order", po);
  store.procurement.saveLine("purchase_order_line", po.id, line);
  store.db
    .prepare(
      `INSERT INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES (?,?,?,'supplier_commitment','stage_entered','active',?,'outbox','outbox:sla','connector:email',?,?)`,
    )
    .run(
      tenantId,
      "po-stage-event:sla:commitment",
      po.id,
      at,
      JSON.stringify({ exactTransitionTime: true, outboxId: "outbox:sla" }),
      at,
    );
  let clock = new Date("2026-08-22T06:00:00.000Z");
  const server = createServer((req, res) => {
    const token = String(req.headers["authorization"] ?? "").replace(
      "Bearer ",
      "",
    );
    const session =
      token === "manager" ? manager : token === "buyer" ? buyer : null;
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void handleProcurementSlaRequest(req, res, path, req.method ?? "GET", {
      db: store.db,
      session,
      now: () => clock,
    })
      .then((handled) => {
        if (!handled) res.writeHead(404).end();
      })
      .catch((error: unknown) =>
        res
          .writeHead(500, { "content-type": "application/json" })
          .end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(
    path: string,
    method = "GET",
    token = "buyer",
    body?: Record<string, unknown>,
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  }
  try {
    assert.equal(
      (await request("/api/procurement/sla", "GET", "")).status,
      401,
    );
    const empty = await request("/api/procurement/sla");
    assert.equal(empty.status, 200);
    assert.equal(empty.body["publishedPolicy"], null);
    assert.deepEqual(empty.body["policyImpacts"], []);
    assert.equal(
      (
        await request("/api/procurement/sla/policies", "POST", "buyer", {
          name: "无权限",
          rules: [rule],
        })
      ).status,
      403,
    );

    const created = await request(
      "/api/procurement/sla/policies",
      "POST",
      "manager",
      { name: "采购执行 SLA V1", description: "五阶段执行策略", rules: [rule] },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const policyId = created.body["item"]["id"] as string;
    assert.equal(created.body["item"]["version"], 1);
    assert.equal(
      created.body["item"]["rules"][0]["description"],
      "Supplier to acknowledge PO",
      "legacy rule payloads gain a stable human-readable directory description",
    );
    assert.equal(
      created.body["item"]["rules"][0]["escalationAfterHours"],
      26,
      "legacy rules preserve behavior while gaining an explicit escalation time",
    );
    assert.deepEqual(created.body["item"]["directoryRules"], [
      {
        id: "commitment-default",
        processStage: "供应商确认期限",
        description: "Supplier to acknowledge PO",
        slaTargetDays: 1,
        gracePeriodDays: 2 / 24,
        escalationAfterDays: 26 / 24,
        appliesTo: "all",
        appliesToLabel: "All Suppliers",
        status: "active",
        advanced: {
          stage: "supplier_commitment",
          risk: "all",
          route: "all",
          deadlineBasis: "stage_entry",
          calendarMode: "elapsed_hours",
          warningHours: 4,
          followupIntervalHours: 24,
          maxFollowups: 3,
          escalationRole: "采购经理",
          messageCategory: "acknowledgement_followup",
          communicationChannel: "email",
        },
      },
    ]);
    assert.equal(
      created.body["item"]["rules"][0]["calendarMode"],
      "elapsed_hours",
      "legacy rules must default to absolute elapsed hours",
    );
    const invalidEscalation = await request(
      "/api/procurement/sla/policies",
      "POST",
      "manager",
      {
        name: "无效升级窗口",
        rules: [{ ...rule, escalationAfterHours: 24 }],
      },
    );
    assert.equal(invalidEscalation.status, 422);
    assert.equal(invalidEscalation.body["code"], "INVALID_SLA_INPUT");
    const draftDashboard = await request("/api/procurement/sla");
    assert.deepEqual(draftDashboard.body["policyImpacts"], [
      {
        policyId,
        policyVersion: 1,
        policyStatus: "draft",
        enabledRules: 1,
        activePurchaseOrders: 1,
        matchedPurchaseOrders: 1,
        readyToEvaluate: 1,
        missingDeadlineEvidence: 0,
        unmatchedPurchaseOrders: 0,
        byStage: {
          po_sent: 0,
          supplier_commitment: 1,
          fulfilment_production: 0,
          dispatch_transit: 0,
          delivery_grn: 0,
        },
        byRoute: { local: 0, import: 0, unclassified: 1 },
      },
    ]);
    const updated = await request(
      `/api/procurement/sla/policies/${encodeURIComponent(policyId)}`,
      "PATCH",
      "manager",
      {
        expectedVersion: 1,
        name: "采购执行 SLA V1",
        description: "已复核",
        rules: [{ ...rule, graceHours: 4 }],
      },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body["item"]["version"], 2);
    const conflict = await request(
      `/api/procurement/sla/policies/${encodeURIComponent(policyId)}`,
      "PATCH",
      "manager",
      { expectedVersion: 1, name: "过期写入", description: "", rules: [rule] },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body["currentVersion"], 2);
    assert.equal(
      (
        await request(
          `/api/procurement/sla/policies/${encodeURIComponent(policyId)}/publish`,
          "POST",
          "buyer",
          { expectedVersion: 2 },
        )
      ).status,
      403,
    );

    const published = await request(
      `/api/procurement/sla/policies/${encodeURIComponent(policyId)}/publish`,
      "POST",
      "manager",
      { expectedVersion: 2 },
    );
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body["item"]["status"], "published");
    assert.equal(published.body["evaluation"]["evaluated"], 1);
    assert.equal(
      store.db
        .prepare(
          `SELECT status FROM twin_projection_jobs
      WHERE tenant_id=? AND source_table='procurement_sla_evaluations' AND source_key=?`,
        )
        .get(tenantId, po.id)?.["status"],
      "queued",
    );
    const dashboard = await request("/api/procurement/sla");
    assert.equal(dashboard.body["publishedPolicy"]["id"], policyId);
    assert.equal(
      dashboard.body["policyImpacts"][0]["policyStatus"],
      "published",
    );
    assert.equal(dashboard.body["policyImpacts"][0]["policyVersion"], 3);
    assert.equal(dashboard.body["policyImpacts"][0]["readyToEvaluate"], 1);
    assert.equal(
      dashboard.body["evaluations"]["items"][0]["purchaseOrderId"],
      po.id,
    );
    assert.equal(
      dashboard.body["evaluations"]["items"][0]["status"],
      "escalated",
    );
    assert.equal(
      dashboard.body["evaluations"]["items"][0]["evidence"]["slaRuleId"],
      rule.id,
    );
    assert.equal(
      dashboard.body["evaluations"]["items"][0]["evidence"]["basisSource"],
      "procurement_po_stage_events:stage_entered",
    );
    assert.equal(
      dashboard.body["evaluations"]["items"][0]["evidence"]["stageEntryEvent"][
        "eventId"
      ],
      "po-stage-event:sla:commitment",
    );
    assert.equal(
      dashboard.body["evaluations"]["items"][0]["evidence"]["calendarMode"],
      "elapsed_hours",
    );
    assert.equal(
      dashboard.body["evaluations"]["items"][0]["evidence"][
        "calendarPreferenceVersion"
      ],
      null,
    );
    assert.deepEqual(
      {
        mode: dashboard.body["tenantCalendar"]["mode"],
        timeZone: dashboard.body["tenantCalendar"]["timeZone"],
        workingDays: dashboard.body["tenantCalendar"]["workingDays"],
        preferenceVersion: dashboard.body["tenantCalendar"]["preferenceVersion"],
        inheritedDefault: dashboard.body["tenantCalendar"]["inheritedDefault"],
        excludeWeekends: dashboard.body["tenantCalendar"]["excludeWeekends"],
        excludePublicHolidays: dashboard.body["tenantCalendar"]["excludePublicHolidays"],
        holidayCountryCode: dashboard.body["tenantCalendar"]["holidayCountryCode"],
        holidaySource: dashboard.body["tenantCalendar"]["holidaySource"],
        holidaySourceVersion: dashboard.body["tenantCalendar"]["holidaySourceVersion"],
      },
      {
        mode: "tenant_working_days",
        timeZone: "Asia/Shanghai",
        workingDays: [1, 2, 3, 4, 5],
        preferenceVersion: null,
        inheritedDefault: true,
        excludeWeekends: true,
        excludePublicHolidays: true,
        holidayCountryCode: "CN",
        holidaySource: "date-holidays",
        holidaySourceVersion: "3.36.0",
      },
    );
    assert.equal(dashboard.body["tenantCalendar"]["holidayDates"].includes("2026-01-01"), true);
    const frozenDueAt = dashboard.body["evaluations"]["items"][0]["dueAt"];

    const replay = await request(
      "/api/procurement/sla/evaluate",
      "POST",
      "buyer",
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body["changed"], 0);
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM procurement_sla_evaluation_events WHERE tenant_id=?",
        )
        .get(tenantId)?.["count"],
      1,
    );

    const storedPo = store.procurement.getDocument<PurchaseOrder>(
      "purchase_order",
      po.id,
    )!;
    store.procurement.saveDocument(
      "purchase_order",
      { ...storedPo.document, updatedAt: "2026-08-22T05:30:00.000Z" },
      storedPo.version,
    );
    const afterRoutineUpdate = await request(
      "/api/procurement/sla/evaluate",
      "POST",
      "buyer",
    );
    assert.equal(afterRoutineUpdate.body["changed"], 1);
    const afterRoutineDashboard = await request("/api/procurement/sla");
    assert.equal(
      afterRoutineDashboard.body["evaluations"]["items"][0]["dueAt"],
      frozenDueAt,
    );
    assert.equal(
      afterRoutineDashboard.body["evaluations"]["items"][0]["evidence"][
        "basisAt"
      ],
      at,
    );
    assert.equal(
      afterRoutineDashboard.body["evaluations"]["items"][0]["evidence"][
        "basisSource"
      ],
      "procurement_po_stage_events:stage_entered",
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM procurement_sla_evaluation_events WHERE tenant_id=?",
        )
        .get(tenantId)?.["count"],
      2,
    );

    clock = new Date("2026-08-21T03:00:00.000Z");
    const statusChanged = await request(
      "/api/procurement/sla/evaluate",
      "POST",
      "buyer",
    );
    assert.equal(statusChanged.body["changed"], 1);
    const changedDashboard = await request("/api/procurement/sla");
    assert.equal(
      changedDashboard.body["evaluations"]["items"][0]["status"],
      "in_grace",
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM procurement_sla_evaluation_events WHERE tenant_id=?",
        )
        .get(tenantId)?.["count"],
      3,
    );

    const evaluationEvents = changedDashboard.body["evaluationEvents"] as Array<
      Record<string, any>
    >;
    assert.equal(evaluationEvents.length, 3);
    assert.deepEqual(
      evaluationEvents.map((event) => event["createdAt"]),
      [...evaluationEvents]
        .map((event) => event["createdAt"])
        .sort((left, right) => right.localeCompare(left)),
    );
    assert.equal(
      evaluationEvents.every((event) => event["purchaseOrderId"] === po.id),
      true,
    );
    assert.equal(
      evaluationEvents.every((event) => event["policyId"] === policyId),
      true,
    );
    assert.equal(
      evaluationEvents.every(
        (event) =>
          typeof event["detail"] === "object" && event["detail"] !== null,
      ),
      true,
    );
    assert.equal(
      evaluationEvents.some(
        (event) =>
          event["detail"]["evidence"]["stageEntryEvent"]["eventId"] ===
          "po-stage-event:sla:commitment",
      ),
      true,
    );

    const insertEvaluationEvent = store.db
      .prepare(`INSERT INTO procurement_sla_evaluation_events
      (tenant_id,id,po_id,policy_id,rule_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`);
    insertEvaluationEvent.run(
      "tenant:other",
      "evaluation-event:other-tenant",
      "po:other",
      "policy:other",
      null,
      "evaluation_created",
      JSON.stringify({
        status: "breached",
        authorization: "Bearer must-not-leak",
      }),
      "2099-01-01T00:00:00.000Z",
    );
    for (let index = 0; index < 101; index += 1) {
      const createdAt = new Date(
        Date.UTC(2026, 7, 23, 0, 0, index),
      ).toISOString();
      insertEvaluationEvent.run(
        tenantId,
        `evaluation-event:cap-${String(index).padStart(3, "0")}`,
        po.id,
        policyId,
        rule.id,
        "evaluation_changed",
        JSON.stringify({
          status: "breached",
          accessToken: `secret-${index}`,
          note: `password=value-${index}`,
        }),
        createdAt,
      );
    }
    const cappedHistory = await request("/api/procurement/sla");
    assert.equal(cappedHistory.body["evaluationEvents"].length, 100);
    assert.equal(
      cappedHistory.body["evaluationEvents"][0]["id"],
      "evaluation-event:cap-100",
    );
    assert.equal(
      cappedHistory.body["evaluationEvents"].some(
        (event: { id?: string }) =>
          event.id === "evaluation-event:other-tenant",
      ),
      false,
    );
    assert.equal(
      cappedHistory.body["evaluationEvents"][0]["detail"]["accessToken"],
      "[REDACTED]",
    );
    assert.equal(
      cappedHistory.body["evaluationEvents"][0]["detail"]["note"],
      "password=[REDACTED]",
    );

    assert.equal(
      (
        await request(
          `/api/procurement/sla/policies/${encodeURIComponent(policyId)}/retire`,
          "POST",
          "buyer",
          { expectedVersion: 3 },
        )
      ).status,
      403,
    );
    const staleRetire = await request(
      `/api/procurement/sla/policies/${encodeURIComponent(policyId)}/retire`,
      "POST",
      "manager",
      { expectedVersion: 2 },
    );
    assert.equal(staleRetire.status, 409);
    assert.equal(staleRetire.body["currentVersion"], 3);
    const retired = await request(
      `/api/procurement/sla/policies/${encodeURIComponent(policyId)}/retire`,
      "POST",
      "manager",
      { expectedVersion: 3 },
    );
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    assert.equal(retired.body["item"]["status"], "retired");
    assert.equal(retired.body["item"]["version"], 4);
    assert.equal(retired.body["clearedEvaluations"], 1);
    assert.equal(
      store.db
        .prepare(
          `SELECT status FROM twin_projection_jobs
      WHERE tenant_id=? AND source_table='procurement_sla_evaluations' AND source_key=?
        AND event_type='procurement_sla_evaluation.deleted'`,
        )
        .get(tenantId, po.id)?.["status"],
      "queued",
    );
    const afterRetire = await request("/api/procurement/sla");
    assert.equal(afterRetire.body["publishedPolicy"], null);
    assert.equal(afterRetire.body["evaluations"]["total"], 0);
    assert.equal(
      afterRetire.body["events"].some(
        (event: { action?: string }) => event.action === "retired",
      ),
      true,
    );
    assert.equal(
      (await request("/api/procurement/sla/evaluate", "POST", "buyer")).status,
      409,
    );
    const jobsBeforeReplacement = store.db
      .prepare(
        `SELECT COUNT(*) AS count FROM twin_projection_jobs
      WHERE tenant_id=? AND source_table='procurement_sla_evaluations' AND source_key=?
        AND event_type='procurement_sla_evaluation.changed'`,
      )
      .get(tenantId, po.id)?.["count"] as number;

    const replacement = await request(
      "/api/procurement/sla/policies",
      "POST",
      "manager",
      {
        name: "采购执行 SLA V2",
        description: "替换策略",
        rules: [{ ...rule, graceHours: 6 }],
      },
    );
    assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
    const replacementPolicyId = replacement.body["item"]["id"] as string;
    const replacementPublished = await request(
      `/api/procurement/sla/policies/${encodeURIComponent(replacementPolicyId)}/publish`,
      "POST",
      "manager",
      { expectedVersion: 1 },
    );
    assert.equal(
      replacementPublished.status,
      200,
      JSON.stringify(replacementPublished.body),
    );
    assert.equal(replacementPublished.body["evaluation"]["changed"], 1);
    const lifecycleJobs = store.db
      .prepare(
        `SELECT source_revision,payload_hash,status FROM twin_projection_jobs
      WHERE tenant_id=? AND source_table='procurement_sla_evaluations' AND source_key=?
        AND event_type='procurement_sla_evaluation.changed' ORDER BY source_revision`,
      )
      .all(tenantId, po.id) as unknown as Array<{
      source_revision: string;
      payload_hash: string;
      status: string;
    }>;
    assert.equal(
      lifecycleJobs.length,
      jobsBeforeReplacement + 1,
      "替换策略必须为同一 PO 保留独立耐久投影作业",
    );
    assert.equal(
      new Set(lifecycleJobs.map((job) => job.source_revision)).size,
      lifecycleJobs.length,
    );
    assert.equal(
      lifecycleJobs.some((job) =>
        job.source_revision.startsWith(`${policyId}:v`),
      ),
      true,
    );
    assert.equal(
      lifecycleJobs.some(
        (job) => job.source_revision === `${replacementPolicyId}:v1`,
      ),
      true,
    );
    assert.equal(
      lifecycleJobs.every((job) => job.status === "queued"),
      true,
    );
    const lifecycleReplay = await request(
      "/api/procurement/sla/evaluate",
      "POST",
      "buyer",
    );
    assert.equal(lifecycleReplay.status, 200);
    assert.equal(lifecycleReplay.body["changed"], 0);
    assert.equal(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM twin_projection_jobs
      WHERE tenant_id=? AND source_table='procurement_sla_evaluations' AND source_key=?
        AND event_type='procurement_sla_evaluation.changed'`,
        )
        .get(tenantId, po.id)?.["count"],
      lifecycleJobs.length,
    );

    const otherSession: Session = { ...buyer, tenantId: "tenant:other" };
    const otherRows = store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM procurement_sla_policies WHERE tenant_id=?",
      )
      .get(otherSession.tenantId) as { count: number };
    assert.equal(otherRows.count, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
  }
});

test("SLA 完整生命周期与自动检查事实会在临时 SQLite 关闭重开后精确保留", async () => {
  const directory = mkdtempSync(join(tmpdir(), "readywork-sla-lifecycle-"));
  const databasePath = join(directory, "readywork.sqlite");
  const lifecycleTenantId = "tenant:sla-lifecycle-reopen";
  const otherTenantId = "tenant:sla-lifecycle-other";
  const lifecycleManager: Session = {
    ...manager,
    tenantId: lifecycleTenantId,
    humanId: "human:lifecycle-manager",
  };
  const at = "2026-08-20T00:00:00.000Z";
  const clock = new Date("2026-08-22T06:00:00.000Z");
  let store: ReturnType<typeof openPersistence> | null = openPersistence(databasePath, {
    tenantId: lifecycleTenantId,
  });
  let server: ReturnType<typeof createServer> | null = null;
  try {
    const supplier: Supplier = {
      id: "supplier:sla-lifecycle",
      tenantId: lifecycleTenantId,
      sourceSystem: "odoo",
      externalId: "SUP-SLA-LIFECYCLE",
      status: "active",
      createdAt: at,
      updatedAt: at,
      name: "生命周期真实供应商",
      contacts: [{
        id: "contact:sla-lifecycle",
        name: "陈经理",
        email: "procurement@supplier-real.cn",
        primary: true,
      }],
      currency: "CNY",
    };
    const po: PurchaseOrder = {
      id: "po:sla-lifecycle",
      tenantId: lifecycleTenantId,
      sourceSystem: "odoo",
      externalId: "P-SLA-LIFECYCLE-001",
      status: "sent",
      createdAt: at,
      updatedAt: at,
      supplierId: supplier.id,
      currency: "CNY",
      orderedAt: at,
    };
    const line: PurchaseOrderLine = {
      id: "line:sla-lifecycle",
      poId: po.id,
      lineNumber: "10",
      itemId: "item:sla-lifecycle",
      description: "生命周期控制阀",
      uom: "EA",
      orderedQty: 1,
      unitPrice: 100,
      currency: "CNY",
      requestedAt: "2026-09-30T00:00:00.000Z",
    };
    store.procurement.saveDocument("supplier", supplier);
    store.procurement.saveDocument("purchase_order", po);
    store.procurement.saveLine("purchase_order_line", po.id, line);
    store.db.prepare(`INSERT INTO procurement_po_stage_events
      (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
      VALUES (?,?,?,'supplier_commitment','stage_entered','active',?,'outbox','outbox:sla-lifecycle','connector:email',?,?)`)
      .run(
        lifecycleTenantId,
        "po-stage-event:sla-lifecycle:commitment",
        po.id,
        at,
        JSON.stringify({ exactTransitionTime: true, outboxId: "outbox:sla-lifecycle" }),
        at,
      );
    store.db.prepare(`INSERT INTO procurement_communication_identities
      (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?, 'active',1,?,?,?,?)`).run(
        lifecycleTenantId,
        "李娜",
        "高级采购专员",
        "东方制造有限公司",
        lifecycleManager.humanId,
        lifecycleManager.humanId,
        at,
        at,
      );
    store.db.prepare(`INSERT INTO procurement_sla_policies
      (tenant_id,id,name,description,status,version,rules_json,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?, 'draft',9,?,?,?,?,?)`).run(
        otherTenantId,
        "policy:other-tenant-sentinel",
        "其他租户策略",
        "不得被当前租户生命周期改写",
        JSON.stringify([{ ...rule, description: "Other tenant rule" }]),
        "human:other",
        "human:other",
        at,
        at,
      );

    server = createServer((req, res) => {
      const token = String(req.headers["authorization"] ?? "").replace("Bearer ", "");
      const session = token === "manager" ? lifecycleManager : null;
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      void handleProcurementSlaRequest(req, res, path, req.method ?? "GET", {
        db: store!.db,
        session,
        now: () => clock,
      }).then((handled) => {
        if (!handled) res.writeHead(404).end();
      }).catch((error: unknown) => {
        res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    async function request(path: string, method = "GET", body?: Record<string, unknown>) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: "Bearer manager",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, any>,
      };
    }

    const empty = await request("/api/procurement/sla");
    assert.equal(empty.status, 200);
    assert.equal(empty.body["publishedPolicy"], null);
    assert.deepEqual(empty.body["draftPolicies"], []);

    const created = await request("/api/procurement/sla/policies", "POST", {
      name: "生命周期 SLA V1",
      description: "初始草稿",
      rules: [rule],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const firstPolicyId = created.body["item"]["id"] as string;
    const updated = await request(
      `/api/procurement/sla/policies/${encodeURIComponent(firstPolicyId)}`,
      "PATCH",
      {
        expectedVersion: 1,
        name: "生命周期 SLA V1",
        description: "已编辑草稿",
        rules: created.body["item"]["rules"],
      },
    );
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body["item"]["version"], 2);
    const published = await request(
      `/api/procurement/sla/policies/${encodeURIComponent(firstPolicyId)}/publish`,
      "POST",
      { expectedVersion: 2 },
    );
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body["item"]["version"], 3);
    assert.equal(published.body["evaluation"]["evaluated"], 1);
    const evaluated = await request("/api/procurement/sla/evaluate", "POST");
    assert.equal(evaluated.status, 200, JSON.stringify(evaluated.body));
    assert.deepEqual(
      { evaluated: evaluated.body["evaluated"], changed: evaluated.body["changed"] },
      { evaluated: 1, changed: 0 },
    );

    const replacement = await request("/api/procurement/sla/policies", "POST", {
      name: "生命周期 SLA V2",
      description: "替换草稿",
      sourcePolicyId: firstPolicyId,
    });
    assert.equal(replacement.status, 201, JSON.stringify(replacement.body));
    const replacementPolicyId = replacement.body["item"]["id"] as string;
    const replacementPublished = await request(
      `/api/procurement/sla/policies/${encodeURIComponent(replacementPolicyId)}/publish`,
      "POST",
      { expectedVersion: 1 },
    );
    assert.equal(replacementPublished.status, 200, JSON.stringify(replacementPublished.body));
    assert.equal(replacementPublished.body["item"]["version"], 2);
    assert.equal(replacementPublished.body["evaluation"]["changed"], 1);

    const automation = new ProcurementSlaAutomationWorker(store.db, {
      workerId: "worker:sla-lifecycle-reopen",
      now: () => clock,
    });
    const automationResult = await automation.runTenant(lifecycleTenantId, {
      force: true,
      actorId: lifecycleManager.humanId,
    });
    assert.equal(automationResult.status, "completed");
    assert.deepEqual(
      {
        created: automationResult.result?.created,
        examined: automationResult.result?.examined,
        autoQueued: automationResult.result?.autoQueued,
        manualReview: automationResult.result?.manualReview.length,
      },
      { created: 1, examined: 1, autoQueued: 0, manualReview: 1 },
    );
    const retired = await request(
      `/api/procurement/sla/policies/${encodeURIComponent(replacementPolicyId)}/retire`,
      "POST",
      { expectedVersion: 2 },
    );
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    assert.equal(retired.body["item"]["version"], 3);
    assert.equal(retired.body["clearedEvaluations"], 1);

    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = null;
    store.close();
    store = null;

    const reopened = openPersistence(databasePath, { tenantId: lifecycleTenantId });
    try {
      const reopenedPolicies = reopened.db.prepare(`SELECT id,status,version FROM procurement_sla_policies
        WHERE tenant_id=?`).all(lifecycleTenantId) as Array<{ id: string; status: string; version: number }>;
      assert.equal(reopenedPolicies.length, 2);
      assert.deepEqual(
        Object.fromEntries(reopenedPolicies.map((policy) => [policy.id, {
          status: policy.status,
          version: policy.version,
        }])),
        {
          [firstPolicyId]: { status: "retired", version: 4 },
          [replacementPolicyId]: { status: "retired", version: 3 },
        },
      );
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM procurement_sla_policy_events WHERE tenant_id=?").get(lifecycleTenantId)?.["count"], 7);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM procurement_sla_evaluations WHERE tenant_id=?").get(lifecycleTenantId)?.["count"], 0);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM procurement_sla_evaluation_events WHERE tenant_id=?").get(lifecycleTenantId)?.["count"], 2);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM procurement_sla_automation_runs WHERE tenant_id=? AND status='completed'").get(lifecycleTenantId)?.["count"], 1);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM procurement_message_drafts WHERE tenant_id=? AND status='draft'").get(lifecycleTenantId)?.["count"], 1);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM procurement_message_draft_events WHERE tenant_id=? AND action='generated_by_sla'").get(lifecycleTenantId)?.["count"], 1);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=?").get(lifecycleTenantId)?.["count"], 0);
      const otherPolicy = reopened.db.prepare("SELECT status,version FROM procurement_sla_policies WHERE tenant_id=? AND id=?")
        .get(otherTenantId, "policy:other-tenant-sentinel") as { status: string; version: number };
      assert.deepEqual(
        { status: otherPolicy.status, version: otherPolicy.version },
        { status: "draft", version: 9 },
      );
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM procurement_sla_policy_events WHERE tenant_id=?").get(otherTenantId)?.["count"], 0);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM procurement_sla_automation_runs WHERE tenant_id=?").get(otherTenantId)?.["count"], 0);
    } finally {
      reopened.close();
    }
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
