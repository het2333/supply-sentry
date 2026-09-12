import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type {
  PurchaseOrder,
  PurchaseOrderLine,
  Supplier,
} from "@readywork/core";
import { openPersistence } from "@readywork/persistence";
import type { Session } from "../src/auth.js";
import { handleProcurementSlaRequest } from "../src/procurement-sla.js";
import { handleProcurementTenantPreferencesRequest } from "../src/procurement-tenant-preferences.js";

test("工作日日历 SLA：真实偏好、周末跳过、版本化重算和评估审计保持一致", async () => {
  const tenantId = "tenant:sla-working-days";
  const manager: Session = {
    username: "manager",
    tenantId,
    humanId: "human:manager",
    name: "王经理",
    role: "采购经理",
    expiresAt: Date.now() + 60_000,
  };
  const store = openPersistence(":memory:", { tenantId });
  const stageEnteredAt = "2026-08-21T14:00:00.000Z"; // Friday 22:00 Asia/Shanghai
  const supplier: Supplier = {
    id: "supplier:calendar",
    tenantId,
    sourceSystem: "odoo",
    externalId: "SUP-CALENDAR",
    status: "active",
    createdAt: stageEnteredAt,
    updatedAt: stageEnteredAt,
    name: "日历测试供应商",
    contacts: [],
    currency: "CNY",
  };
  const po: PurchaseOrder = {
    id: "po:calendar",
    tenantId,
    sourceSystem: "odoo",
    externalId: "P-CALENDAR-001",
    status: "sent",
    createdAt: stageEnteredAt,
    updatedAt: stageEnteredAt,
    supplierId: supplier.id,
    currency: "CNY",
    orderedAt: stageEnteredAt,
  };
  const line: PurchaseOrderLine = {
    id: "line:calendar",
    poId: po.id,
    lineNumber: "10",
    itemId: "item:calendar",
    description: "气动阀",
    uom: "EA",
    orderedQty: 10,
    unitPrice: 125,
    currency: "CNY",
    requestedAt: "2026-09-01T00:00:00.000Z",
  };
  store.procurement.saveDocument("supplier", supplier);
  store.procurement.saveDocument("purchase_order", po);
  store.procurement.saveLine("purchase_order_line", po.id, line);
  store.db
    .prepare(
      `INSERT INTO procurement_po_stage_events
    (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
    VALUES (?,?,?,'supplier_commitment','stage_entered','active',?,'outbox','outbox:calendar','connector:email',?,?)`,
    )
    .run(
      tenantId,
      "po-stage-event:calendar",
      po.id,
      stageEnteredAt,
      JSON.stringify({ exactTransitionTime: true }),
      stageEnteredAt,
    );

  let clock = new Date("2026-08-21T15:00:00.000Z"); // Friday 23:00 Asia/Shanghai
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    void (async () => {
      const context = { db: store.db, session: manager, now: () => clock };
      if (
        await handleProcurementTenantPreferencesRequest(
          req,
          res,
          path,
          req.method ?? "GET",
          context,
        )
      )
        return;
      if (
        await handleProcurementSlaRequest(
          req,
          res,
          path,
          req.method ?? "GET",
          context,
        )
      )
        return;
      res.writeHead(404).end();
    })().catch((error: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(
    path: string,
    method = "GET",
    body?: Record<string, unknown>,
  ) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, any>,
    };
  }

  try {
    const preferences = await request(
      "/api/procurement/tenant-preferences",
      "PUT",
      {
        expectedVersion: 0,
        countryCode: "CN",
        workingDays: [1, 2, 3, 4, 5],
        timeZone: "Asia/Shanghai",
        dateFormat: "YYYY-MM-DD",
        slaEscalationsEnabled: true,
        excludeWeekends: true,
        excludePublicHolidays: true,
        autoCalculateLeadTime: true,
        reason: "采购团队采用中国标准工作日进行 SLA 计时",
      },
    );
    assert.equal(preferences.status, 201, JSON.stringify(preferences.body));
    assert.equal(preferences.body["item"]["version"], 1);

    const workingDayRule = {
      id: "commitment-working-days",
      name: "工作日供应商确认",
      enabled: true,
      route: "all",
      stage: "supplier_commitment",
      risk: "all",
      deadlineBasis: "stage_entry",
      calendarMode: "tenant_working_days",
      targetOffsetHours: 4,
      warningHours: 4,
      graceHours: 2,
      followupIntervalHours: 4,
      maxFollowups: 3,
      escalationRole: "采购经理",
      messageCategory: "acknowledgement_followup",
      communicationChannel: "email",
    };
    const invalid = await request("/api/procurement/sla/policies", "POST", {
      name: "非法日历",
      rules: [{ ...workingDayRule, calendarMode: "browser_local_time" }],
    });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body["code"], "INVALID_SLA_INPUT");

    const created = await request("/api/procurement/sla/policies", "POST", {
      name: "工作日 SLA",
      description: "按租户工作日与时区计时",
      rules: [workingDayRule],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const policyId = created.body["item"]["id"] as string;
    const published = await request(
      `/api/procurement/sla/policies/${encodeURIComponent(policyId)}/publish`,
      "POST",
      { expectedVersion: 1 },
    );
    assert.equal(published.status, 200, JSON.stringify(published.body));

    const dashboard = await request("/api/procurement/sla");
    const first = dashboard.body["evaluations"]["items"][0];
    assert.equal(
      first["status"],
      "due_soon",
      "Friday 23:00 is inside the four-working-hour warning window",
    );
    assert.equal(
      first["dueAt"],
      "2026-08-23T18:00:00.000Z",
      "four working hours from Friday 22:00 end Monday 02:00 Shanghai",
    );
    assert.equal(first["graceUntil"], "2026-08-23T20:00:00.000Z");
    assert.equal(first["evidence"]["calendarExcludeWeekends"], true);
    assert.equal(first["evidence"]["calendarExcludePublicHolidays"], true);
    assert.equal(first["evidence"]["calendarHolidayCountryCode"], "CN");
    assert.equal(first["evidence"]["calendarHolidaySource"], "date-holidays");
    assert.equal(first["evidence"]["calendarHolidaySourceVersion"], "3.36.0");
    assert.equal(first["evidence"]["calendarHolidaySourceLicense"], "ISC AND CC-BY-3.0");
    assert.equal(first["evidence"]["calendarHolidayDates"].includes("2026-01-01"), true);
    assert.deepEqual(
      {
        mode: first["evidence"]["calendarMode"],
        timeZone: first["evidence"]["calendarTimeZone"],
        workingDays: first["evidence"]["calendarWorkingDays"],
        version: first["evidence"]["calendarPreferenceVersion"],
        inherited: first["evidence"]["calendarInheritedDefault"],
      },
      {
        mode: "tenant_working_days",
        timeZone: "Asia/Shanghai",
        workingDays: [1, 2, 3, 4, 5],
        version: 1,
        inherited: false,
      },
    );
    const firstFingerprint = first["fingerprint"];

    const changedPreferences = await request(
      "/api/procurement/tenant-preferences",
      "PUT",
      {
        expectedVersion: 1,
        countryCode: "CN",
        workingDays: [1, 2, 3, 4, 5, 6],
        timeZone: "Asia/Shanghai",
        dateFormat: "YYYY-MM-DD",
        slaEscalationsEnabled: true,
        excludeWeekends: false,
        excludePublicHolidays: true,
        autoCalculateLeadTime: true,
        reason: "供应商确认团队开始执行周六工作日 SLA 排班",
      },
    );
    assert.equal(
      changedPreferences.status,
      200,
      JSON.stringify(changedPreferences.body),
    );
    assert.equal(changedPreferences.body["item"]["version"], 2);
    const reevaluated = await request("/api/procurement/sla/evaluate", "POST");
    assert.equal(reevaluated.status, 200);
    assert.equal(
      reevaluated.body["changed"],
      1,
      "calendar version changes must produce a new persisted evaluation",
    );

    const afterCalendarChange = await request("/api/procurement/sla");
    const second = afterCalendarChange.body["evaluations"]["items"][0];
    assert.equal(
      second["dueAt"],
      "2026-08-21T18:00:00.000Z",
      "Saturday now counts as a working day",
    );
    assert.equal(second["graceUntil"], "2026-08-21T20:00:00.000Z");
    assert.equal(second["evidence"]["calendarPreferenceVersion"], 2);
    assert.notEqual(second["fingerprint"], firstFingerprint);
    assert.equal(afterCalendarChange.body["evaluationEvents"].length, 2);
    assert.equal(
      afterCalendarChange.body["evaluationEvents"][0]["detail"]["evidence"][
        "calendarPreferenceVersion"
      ],
      2,
    );
    const publishedEvent = afterCalendarChange.body["events"].find(
      (event: Record<string, any>) => event["action"] === "published",
    );
    assert.equal(publishedEvent["detail"]["workingDayRuleCount"], 1);
    assert.equal(
      publishedEvent["detail"]["tenantCalendar"]["preferenceVersion"],
      1,
      "policy publication audit freezes the calendar visible at publish time",
    );

    clock = new Date("2026-08-21T19:00:00.000Z");
    const graceEvaluation = await request(
      "/api/procurement/sla/evaluate",
      "POST",
    );
    assert.equal(graceEvaluation.body["changed"], 1);
    const inGrace = await request("/api/procurement/sla");
    assert.equal(inGrace.body["evaluations"]["items"][0]["status"], "in_grace");
    assert.equal(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM procurement_tenant_preference_events WHERE tenant_id=?`,
        )
        .get(tenantId)?.["count"],
      2,
    );
    assert.equal(
      store.db
        .prepare(
          `SELECT COUNT(*) AS count FROM procurement_sla_evaluation_events WHERE tenant_id=?`,
        )
        .get(tenantId)?.["count"],
      3,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
  }
});
