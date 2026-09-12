import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { PurchaseOrder } from "@readywork/core";
import {
  enqueueTwinProjectionInCurrentTransaction,
  twinProjectionPayloadHash,
} from "@readywork/persistence";
import { can, type Session } from "./auth.js";
import { redactSensitiveValue } from "./http-errors.js";
import {
  addSlaCalendarHours,
  type SlaCalendarMode,
  type SlaCalendarSnapshot,
} from "./procurement-sla-calendar.js";
import {
  effectiveProcurementWorkingDays,
  effectiveProcurementTenantPreferences,
  getProcurementTenantPreferences,
} from "./procurement-tenant-preferences.js";
import { procurementPublicHolidaySnapshot } from "./procurement-public-holidays.js";
import { procurementPortfolio } from "./procurement-workbench.js";

export interface ProcurementSlaContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly now?: () => Date;
}
export type SlaRoute = "all" | "local" | "import" | "unclassified";
export type SlaRisk = "all" | "high" | "medium" | "low";
export type SlaStage =
  | "po_sent"
  | "supplier_commitment"
  | "fulfilment_production"
  | "dispatch_transit"
  | "delivery_grn";
export type SlaDeadlineBasis = "stage_entry" | "rihd";
export type SlaEvaluationStatus =
  | "on_track"
  | "due_soon"
  | "in_grace"
  | "breached"
  | "escalated"
  | "blocked_missing_evidence"
  | "unmatched";
export type SlaMessageCategory =
  | "acknowledgement_followup"
  | "production_progress_followup"
  | "dispatch_followup"
  | "delivery_status_escalation"
  | "grn_followup";
export type SlaCommunicationChannel = "email" | "whatsapp";
export interface SlaRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  route: SlaRoute;
  stage: SlaStage;
  risk: SlaRisk;
  deadlineBasis: SlaDeadlineBasis;
  calendarMode: SlaCalendarMode;
  targetOffsetHours: number;
  warningHours: number;
  graceHours: number;
  escalationAfterHours: number;
  followupIntervalHours: number;
  maxFollowups: number;
  escalationRole: string;
  messageCategory: SlaMessageCategory;
  communicationChannel: SlaCommunicationChannel;
}
interface PolicyRow {
  tenant_id: string;
  id: string;
  name: string;
  description: string;
  status: "draft" | "published" | "retired";
  version: number;
  rules_json: string;
  created_by: string;
  updated_by: string;
  published_by: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}
interface EvaluationRow {
  tenant_id: string;
  po_id: string;
  policy_id: string;
  policy_version: number;
  rule_id: string | null;
  stage: SlaStage;
  status: SlaEvaluationStatus;
  due_at: string | null;
  grace_until: string | null;
  next_followup_at: string | null;
  followup_count: number;
  evidence_json: string;
  fingerprint: string;
  version: number;
  evaluated_at: string;
  updated_at: string;
}
interface PortfolioItem {
  id: string;
  number: string;
  supplierId: string;
  supplierName: string;
  route: Exclude<SlaRoute, "all">;
  stage: SlaStage;
  stageLabel: string;
  risk: Exclude<SlaRisk, "all">;
  riskPublicationState: "published" | "provisional" | "not_published";
  requiredInHouseAt: string | null;
  riskFactors: Array<{
    code: string;
    label: string;
    score: number;
    evidence: string;
    evidenceDetail?: Record<string, unknown>;
  }>;
  leadTimeEvidence?: Array<Record<string, unknown>>;
  active: boolean;
  lastActivityAt: string | null;
}
interface Portfolio {
  items: PortfolioItem[];
}
interface PoRow {
  id: string;
  version: number;
  json: string;
  updated_at: string;
}
interface SlaPolicyImpact {
  policyId: string;
  policyVersion: number;
  policyStatus: PolicyRow["status"];
  enabledRules: number;
  activePurchaseOrders: number;
  matchedPurchaseOrders: number;
  readyToEvaluate: number;
  missingDeadlineEvidence: number;
  unmatchedPurchaseOrders: number;
  byStage: Record<SlaStage, number>;
  byRoute: Record<Exclude<SlaRoute, "all">, number>;
}

const stages: SlaStage[] = [
  "po_sent",
  "supplier_commitment",
  "fulfilment_production",
  "dispatch_transit",
  "delivery_grn",
];
const routes: SlaRoute[] = ["all", "local", "import", "unclassified"];
const risks: SlaRisk[] = ["all", "high", "medium", "low"];
const bases: SlaDeadlineBasis[] = ["stage_entry", "rihd"];
const calendarModes: SlaCalendarMode[] = [
  "elapsed_hours",
  "tenant_working_days",
];
const categories: SlaMessageCategory[] = [
  "acknowledgement_followup",
  "production_progress_followup",
  "dispatch_followup",
  "delivery_status_escalation",
  "grn_followup",
];
const communicationChannels: SlaCommunicationChannel[] = ["email", "whatsapp"];

const categoryDescriptions: Record<SlaMessageCategory, string> = {
  acknowledgement_followup: "Supplier to acknowledge PO",
  production_progress_followup: "Supplier production progress update",
  dispatch_followup: "Supplier dispatch confirmation",
  delivery_status_escalation: "Delivery status escalation",
  grn_followup: "Goods receipt confirmation",
};

export async function handleProcurementSlaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementSlaContext,
): Promise<boolean> {
  const root = path === "/api/procurement/sla";
  const create = path === "/api/procurement/sla/policies";
  const evaluate = path === "/api/procurement/sla/evaluate";
  const policyMatch = path.match(
    /^\/api\/procurement\/sla\/policies\/([^/]+)$/,
  );
  const publishMatch = path.match(
    /^\/api\/procurement\/sla\/policies\/([^/]+)\/publish$/,
  );
  const retireMatch = path.match(
    /^\/api\/procurement\/sla\/policies\/([^/]+)\/retire$/,
  );
  if (
    !root &&
    !create &&
    !evaluate &&
    !policyMatch &&
    !publishMatch &&
    !retireMatch
  )
    return false;
  if (!context.session) {
    sendJson(res, 401, { error: "未登录或会话已过期", code: "UNAUTHORIZED" });
    return true;
  }
  const { db, session } = context;
  try {
    if (root && method === "GET") {
      if (!can(session, "read")) return forbidden(res, "无读取 SLA 策略权限");
      const policies = listPolicies(db, session.tenantId);
      const policyRows = db
        .prepare(
          `SELECT * FROM procurement_sla_policies WHERE tenant_id=? ORDER BY created_at DESC,id DESC`,
        )
        .all(session.tenantId) as unknown as PolicyRow[];
      const evaluations = listEvaluations(db, session.tenantId);
      const evaluationEvents = listEvaluationEvents(db, session.tenantId);
      const counts = Object.fromEntries(
        [
          "on_track",
          "due_soon",
          "in_grace",
          "breached",
          "escalated",
          "blocked_missing_evidence",
          "unmatched",
        ].map((status) => [
          status,
          evaluations.filter((item) => item.status === status).length,
        ]),
      );
      const eventRows = db
        .prepare(
          `SELECT policy_id,actor_id,action,detail_json,created_at FROM procurement_sla_policy_events
        WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT 100`,
        )
        .all(session.tenantId) as Array<{
        policy_id: string;
        actor_id: string;
        action: string;
        detail_json: string;
        created_at: string;
      }>;
      sendJson(
        res,
        200,
        redactSensitiveValue({
          policies,
          publishedPolicy:
            policies.find((item) => item.status === "published") ?? null,
          draftPolicies: policies.filter((item) => item.status === "draft"),
          policyImpacts: policyRows.map((policy) =>
            previewPolicyImpact(db, session.tenantId, policy),
          ),
          evaluations: {
            items: evaluations,
            total: evaluations.length,
            counts,
          },
          evaluationEvents,
          events: eventRows.map((row) => ({
            policyId: row.policy_id,
            actorId: row.actor_id,
            action: row.action,
            detail: safeJson(row.detail_json),
            createdAt: row.created_at,
          })),
          tenantCalendar: tenantWorkingCalendar(db, session.tenantId, context.now?.() ?? new Date()),
          permissions: {
            operate: can(session, "operate"),
            approve: can(session, "approve"),
            configure: can(session, "configure"),
          },
        }),
      );
      return true;
    }
    if (create && method === "POST") {
      if (!can(session, "configure"))
        return forbidden(res, "只有采购经理或管理员可以创建 SLA 草稿");
      const body = await readJsonBody(req);
      assertOnlyKeys(body, ["name", "description", "rules", "sourcePolicyId"]);
      const sourcePolicyId = optionalText(body["sourcePolicyId"], 300);
      const source = sourcePolicyId
        ? getPolicy(db, session.tenantId, sourcePolicyId)
        : undefined;
      if (sourcePolicyId && !source) throw new SlaNotFoundError();
      const name = requiredText(body["name"], "name", 120);
      const description = optionalText(body["description"], 1000) ?? "";
      const rules =
        body["rules"] === undefined && source
          ? parseRules(source.rules_json)
          : validateRules(body["rules"]);
      const now = (context.now?.() ?? new Date()).toISOString();
      const id = `procurement-sla-policy:${randomUUID()}`;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO procurement_sla_policies
          (tenant_id,id,name,description,status,version,rules_json,created_by,updated_by,created_at,updated_at)
          VALUES (?,?,?,?, 'draft',1,?,?,?,?,?)`,
        ).run(
          session.tenantId,
          id,
          name,
          description,
          JSON.stringify(rules),
          session.humanId,
          session.humanId,
          now,
          now,
        );
        insertPolicyEvent(
          db,
          session.tenantId,
          id,
          session.humanId,
          "draft_created",
          { sourcePolicyId: sourcePolicyId ?? null, ruleCount: rules.length },
          now,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      sendJson(res, 201, {
        item: presentPolicy(getPolicy(db, session.tenantId, id)!),
      });
      return true;
    }
    if (policyMatch && method === "PATCH") {
      if (!can(session, "configure"))
        return forbidden(res, "只有采购经理或管理员可以编辑 SLA 草稿");
      const id = decodePath(policyMatch[1]!);
      const body = await readJsonBody(req);
      assertOnlyKeys(body, ["expectedVersion", "name", "description", "rules"]);
      const expectedVersion = positiveInteger(
        body["expectedVersion"],
        "expectedVersion",
      );
      const name = requiredText(body["name"], "name", 120);
      const description = optionalText(body["description"], 1000) ?? "";
      const rules = validateRules(body["rules"]);
      const now = (context.now?.() ?? new Date()).toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = getPolicy(db, session.tenantId, id);
        if (!current) throw new SlaNotFoundError();
        if (current.status !== "draft")
          throw new SlaStateError("只有草稿策略可以编辑");
        if (current.version !== expectedVersion)
          throw new SlaVersionError(current.version);
        const result = db
          .prepare(
            `UPDATE procurement_sla_policies SET name=?,description=?,rules_json=?,version=version+1,updated_by=?,updated_at=?
          WHERE tenant_id=? AND id=? AND status='draft' AND version=?`,
          )
          .run(
            name,
            description,
            JSON.stringify(rules),
            session.humanId,
            now,
            session.tenantId,
            id,
            expectedVersion,
          );
        if (result.changes !== 1)
          throw new SlaVersionError(
            getPolicy(db, session.tenantId, id)?.version ?? expectedVersion,
          );
        insertPolicyEvent(
          db,
          session.tenantId,
          id,
          session.humanId,
          "draft_updated",
          { previousVersion: expectedVersion, ruleCount: rules.length },
          now,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      sendJson(res, 200, {
        item: presentPolicy(getPolicy(db, session.tenantId, id)!),
      });
      return true;
    }
    if (publishMatch && method === "POST") {
      if (!can(session, "configure") || !can(session, "approve"))
        return forbidden(
          res,
          "发布 SLA 策略需要采购经理或管理员的配置与审批权限",
        );
      const id = decodePath(publishMatch[1]!);
      const body = await readJsonBody(req);
      assertOnlyKeys(body, ["expectedVersion"]);
      const expectedVersion = positiveInteger(
        body["expectedVersion"],
        "expectedVersion",
      );
      const now = (context.now?.() ?? new Date()).toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = getPolicy(db, session.tenantId, id);
        if (!current) throw new SlaNotFoundError();
        if (current.status !== "draft")
          throw new SlaStateError("只有草稿策略可以发布");
        if (current.version !== expectedVersion)
          throw new SlaVersionError(current.version);
        const previous = db
          .prepare(
            `SELECT id,version FROM procurement_sla_policies WHERE tenant_id=? AND status='published'`,
          )
          .get(session.tenantId) as { id: string; version: number } | undefined;
        if (previous) {
          db.prepare(
            `UPDATE procurement_sla_policies SET status='retired',version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND id=? AND status='published'`,
          ).run(session.humanId, now, session.tenantId, previous.id);
          insertPolicyEvent(
            db,
            session.tenantId,
            previous.id,
            session.humanId,
            "retired_by_publish",
            { replacementPolicyId: id, previousVersion: previous.version },
            now,
          );
        }
        const result = db
          .prepare(
            `UPDATE procurement_sla_policies SET status='published',version=version+1,published_by=?,published_at=?,updated_by=?,updated_at=?
          WHERE tenant_id=? AND id=? AND status='draft' AND version=?`,
          )
          .run(
            session.humanId,
            now,
            session.humanId,
            now,
            session.tenantId,
            id,
            expectedVersion,
          );
        if (result.changes !== 1)
          throw new SlaVersionError(
            getPolicy(db, session.tenantId, id)?.version ?? expectedVersion,
          );
        const publishedRules = parseRules(current.rules_json);
        const workingDayRuleCount = publishedRules.filter(
          (rule) => rule.enabled && rule.calendarMode === "tenant_working_days",
        ).length;
        insertPolicyEvent(
          db,
          session.tenantId,
          id,
          session.humanId,
          "published",
          {
            previousPublishedPolicyId: previous?.id ?? null,
            previousVersion: expectedVersion,
            workingDayRuleCount,
            tenantCalendar:
              workingDayRuleCount > 0
                ? tenantWorkingCalendar(db, session.tenantId, new Date(now))
                : null,
          },
          now,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const policy = getPolicy(db, session.tenantId, id)!;
      sendJson(res, 200, {
        item: presentPolicy(policy),
        evaluation: refreshSlaEvaluations(
          db,
          session.tenantId,
          session.humanId,
          context.now?.() ?? new Date(),
        ),
      });
      return true;
    }
    if (retireMatch && method === "POST") {
      if (!can(session, "configure") || !can(session, "approve"))
        return forbidden(
          res,
          "退役 SLA 策略需要采购经理或管理员的配置与审批权限",
        );
      const id = decodePath(retireMatch[1]!);
      const body = await readJsonBody(req);
      assertOnlyKeys(body, ["expectedVersion"]);
      const expectedVersion = positiveInteger(
        body["expectedVersion"],
        "expectedVersion",
      );
      const now = (context.now?.() ?? new Date()).toISOString();
      let clearedEvaluations = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = getPolicy(db, session.tenantId, id);
        if (!current) throw new SlaNotFoundError();
        if (current.status !== "published")
          throw new SlaStateError("只有当前已发布策略可以退役");
        if (current.version !== expectedVersion)
          throw new SlaVersionError(current.version);
        const retiredEvaluations = db
          .prepare(
            `SELECT po_id,version FROM procurement_sla_evaluations
          WHERE tenant_id=? AND policy_id=? ORDER BY po_id`,
          )
          .all(session.tenantId, id) as Array<{
          po_id: string;
          version: number;
        }>;
        const result = db
          .prepare(
            `UPDATE procurement_sla_policies SET status='retired',version=version+1,updated_by=?,updated_at=?
          WHERE tenant_id=? AND id=? AND status='published' AND version=?`,
          )
          .run(session.humanId, now, session.tenantId, id, expectedVersion);
        if (result.changes !== 1)
          throw new SlaVersionError(
            getPolicy(db, session.tenantId, id)?.version ?? expectedVersion,
          );
        const projectionResult = db
          .prepare(
            `DELETE FROM procurement_sla_evaluations WHERE tenant_id=? AND policy_id=?`,
          )
          .run(session.tenantId, id);
        clearedEvaluations = Number(projectionResult.changes);
        for (const evaluation of retiredEvaluations)
          enqueueTwinProjectionInCurrentTransaction(db, {
            tenantId: session.tenantId,
            sourceTable: "procurement_sla_evaluations",
            sourceKey: evaluation.po_id,
            sourceRevision: slaEvaluationSourceRevision(
              id,
              evaluation.version + 1,
            ),
            eventType: "procurement_sla_evaluation.deleted",
            payloadHash: twinProjectionPayloadHash({
              poId: evaluation.po_id,
              policyId: id,
              deleted: true,
            }),
            availableAt: now,
          });
        insertPolicyEvent(
          db,
          session.tenantId,
          id,
          session.humanId,
          "retired",
          {
            previousVersion: expectedVersion,
            clearedEvaluationProjections: clearedEvaluations,
          },
          now,
        );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      sendJson(res, 200, {
        item: presentPolicy(getPolicy(db, session.tenantId, id)!),
        clearedEvaluations,
      });
      return true;
    }
    if (evaluate && method === "POST") {
      if (!can(session, "operate"))
        return forbidden(res, "无运行 SLA 评估权限");
      sendJson(
        res,
        200,
        refreshSlaEvaluations(
          db,
          session.tenantId,
          session.humanId,
          context.now?.() ?? new Date(),
        ),
      );
      return true;
    }
    sendJson(res, 405, { error: "不支持的方法", code: "METHOD_NOT_ALLOWED" });
    return true;
  } catch (error) {
    sendSlaError(res, error);
    return true;
  }
}

function previewPolicyImpact(
  db: DatabaseSync,
  tenantId: string,
  policy: PolicyRow,
): SlaPolicyImpact {
  const rules = parseRules(policy.rules_json).filter((rule) => rule.enabled);
  const items = (
    procurementPortfolio(db, tenantId) as unknown as Portfolio
  ).items.filter((item) => item.active);
  const poRows = db
    .prepare(
      `SELECT id,version,json,updated_at FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order'`,
    )
    .all(tenantId) as unknown as PoRow[];
  const poById = new Map(poRows.map((row) => [row.id, row] as const));
  const byStage = Object.fromEntries(
    stages.map((stage) => [stage, 0]),
  ) as Record<SlaStage, number>;
  const byRoute: Record<Exclude<SlaRoute, "all">, number> = {
    local: 0,
    import: 0,
    unclassified: 0,
  };
  let matchedPurchaseOrders = 0;
  let readyToEvaluate = 0;
  let missingDeadlineEvidence = 0;
  let unmatchedPurchaseOrders = 0;
  for (const item of items) {
    byStage[item.stage] += 1;
    byRoute[item.route] += 1;
    const rule = matchRule(rules, item);
    if (!rule) {
      unmatchedPurchaseOrders += 1;
      continue;
    }
    matchedPurchaseOrders += 1;
    const poRow = poById.get(item.id);
    if (!poRow) {
      missingDeadlineEvidence += 1;
      continue;
    }
    const po = JSON.parse(poRow.json) as PurchaseOrder & {
      promisedAt?: string;
      requiredInHouseAt?: string;
    };
    const basisValue =
      rule.deadlineBasis === "rihd"
        ? (item.requiredInHouseAt ??
          po.requiredInHouseAt ??
          po.promisedAt ??
          null)
        : (exactStageEntryEvidence(db, tenantId, item.id, item.stage)
            ?.occurredAt ?? null);
    if (basisValue && Number.isFinite(Date.parse(basisValue)))
      readyToEvaluate += 1;
    else missingDeadlineEvidence += 1;
  }
  return {
    policyId: policy.id,
    policyVersion: policy.version,
    policyStatus: policy.status,
    enabledRules: rules.length,
    activePurchaseOrders: items.length,
    matchedPurchaseOrders,
    readyToEvaluate,
    missingDeadlineEvidence,
    unmatchedPurchaseOrders,
    byStage,
    byRoute,
  };
}

export function refreshSlaEvaluations(
  db: DatabaseSync,
  tenantId: string,
  actorId: string,
  now: Date,
): {
  evaluated: number;
  changed: number;
  policyId: string;
  policyVersion: number;
} {
  const policy = db
    .prepare(
      `SELECT * FROM procurement_sla_policies WHERE tenant_id=? AND status='published'`,
    )
    .get(tenantId) as unknown as PolicyRow | undefined;
  if (!policy) throw new SlaStateError("尚未发布 SLA 策略");
  const rules = parseRules(policy.rules_json).filter((rule) => rule.enabled);
  const portfolio = procurementPortfolio(db, tenantId) as unknown as Portfolio;
  const items = portfolio.items.filter((item) => item.active);
  const poRows = db
    .prepare(
      `SELECT id,version,json,updated_at FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order'`,
    )
    .all(tenantId) as unknown as PoRow[];
  const poById = new Map(poRows.map((row) => [row.id, row] as const));
  const nowIso = now.toISOString();
  let changed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of items) {
      const poRow = poById.get(item.id);
      if (!poRow) continue;
      const po = JSON.parse(poRow.json) as PurchaseOrder & {
        promisedAt?: string;
        requiredInHouseAt?: string;
      };
      const rule = matchRule(rules, item);
      const evaluation = evaluateItem(
        db,
        tenantId,
        policy,
        item,
        po,
        poRow,
        rule,
        now,
      );
      const current = getEvaluation(db, tenantId, item.id);
      if (current?.fingerprint === evaluation.fingerprint) {
        db.prepare(
          `UPDATE procurement_sla_evaluations SET evaluated_at=?,updated_at=? WHERE tenant_id=? AND po_id=?`,
        ).run(nowIso, nowIso, tenantId, item.id);
        continue;
      }
      if (!current) {
        db.prepare(
          `INSERT INTO procurement_sla_evaluations
          (tenant_id,po_id,policy_id,policy_version,rule_id,stage,status,due_at,grace_until,next_followup_at,followup_count,evidence_json,fingerprint,version,evaluated_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        ).run(
          tenantId,
          item.id,
          policy.id,
          policy.version,
          evaluation.ruleId,
          item.stage,
          evaluation.status,
          evaluation.dueAt,
          evaluation.graceUntil,
          evaluation.nextFollowupAt,
          evaluation.followupCount,
          JSON.stringify(evaluation.evidence),
          evaluation.fingerprint,
          nowIso,
          nowIso,
        );
      } else {
        db.prepare(
          `UPDATE procurement_sla_evaluations SET policy_id=?,policy_version=?,rule_id=?,stage=?,status=?,due_at=?,grace_until=?,next_followup_at=?,followup_count=?,evidence_json=?,fingerprint=?,version=version+1,evaluated_at=?,updated_at=?
          WHERE tenant_id=? AND po_id=?`,
        ).run(
          policy.id,
          policy.version,
          evaluation.ruleId,
          item.stage,
          evaluation.status,
          evaluation.dueAt,
          evaluation.graceUntil,
          evaluation.nextFollowupAt,
          evaluation.followupCount,
          JSON.stringify(evaluation.evidence),
          evaluation.fingerprint,
          nowIso,
          nowIso,
          tenantId,
          item.id,
        );
      }
      db.prepare(
        `INSERT INTO procurement_sla_evaluation_events (tenant_id,id,po_id,policy_id,rule_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        tenantId,
        `procurement-sla-evaluation-event:${randomUUID()}`,
        item.id,
        policy.id,
        evaluation.ruleId,
        current ? "evaluation_changed" : "evaluation_created",
        JSON.stringify({
          previousStatus: current?.status ?? null,
          status: evaluation.status,
          dueAt: evaluation.dueAt,
          graceUntil: evaluation.graceUntil,
          fingerprint: evaluation.fingerprint,
          evidence: evaluation.evidence,
          actorId,
        }),
        nowIso,
      );
      const storedEvaluation = getEvaluation(db, tenantId, item.id)!;
      enqueueTwinProjectionInCurrentTransaction(db, {
        tenantId,
        sourceTable: "procurement_sla_evaluations",
        sourceKey: item.id,
        sourceRevision: slaEvaluationSourceRevision(
          storedEvaluation.policy_id,
          storedEvaluation.version,
        ),
        eventType: "procurement_sla_evaluation.changed",
        payloadHash: twinProjectionPayloadHash(storedEvaluation),
        availableAt: nowIso,
      });
      changed += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    evaluated: items.length,
    changed,
    policyId: policy.id,
    policyVersion: policy.version,
  };
}

function slaEvaluationSourceRevision(
  policyId: string,
  version: number,
): string {
  return `${policyId}:v${version}`;
}

function evaluateItem(
  db: DatabaseSync,
  tenantId: string,
  policy: PolicyRow,
  item: PortfolioItem,
  po: PurchaseOrder & { promisedAt?: string; requiredInHouseAt?: string },
  poRow: PoRow,
  rule: SlaRule | undefined,
  now: Date,
) {
  if (!rule)
    return fingerprintEvaluation({
      ruleId: null,
      status: "unmatched" as const,
      dueAt: null,
      graceUntil: null,
      nextFollowupAt: null,
      followupCount: 0,
      evidence: {
        reason: "当前发布策略没有匹配路线、阶段与风险的启用规则",
        route: item.route,
        stage: item.stage,
        risk: item.risk,
        riskPublicationState: item.riskPublicationState,
        riskFactors: item.riskFactors,
        leadTimeEvidence: item.leadTimeEvidence ?? [],
        poVersion: poRow.version,
      },
    });
  const stageEntry =
    rule.deadlineBasis === "stage_entry"
      ? exactStageEntryEvidence(db, tenantId, item.id, item.stage)
      : null;
  const basisValue =
    rule.deadlineBasis === "rihd"
      ? (item.requiredInHouseAt ??
        po.requiredInHouseAt ??
        po.promisedAt ??
        null)
      : (stageEntry?.occurredAt ?? null);
  const basisSource =
    rule.deadlineBasis === "rihd"
      ? "portfolio.requiredInHouseAt"
      : stageEntry
        ? `procurement_po_stage_events:${stageEntry.eventType}`
        : "procurement_po_stage_events:missing";
  const basisTime = basisValue ? Date.parse(basisValue) : Number.NaN;
  const calendar = slaCalendarForRule(
    db,
    tenantId,
    rule.calendarMode,
    Number.isFinite(basisTime) ? basisTime : now,
  );
  const calendarEvidence = presentCalendarEvidence(calendar);
  const followupSummary = db
    .prepare(
      `SELECT COUNT(*) AS count,MAX(sent_at) AS last_sent_at FROM procurement_message_drafts
    WHERE tenant_id=? AND purchase_order_id=? AND status='sent'
      AND json_extract(trigger_evidence_json,'$.slaPolicyId')=? AND json_extract(trigger_evidence_json,'$.slaRuleId')=?`,
    )
    .get(tenantId, item.id, policy.id, rule.id) as
    | { count: number; last_sent_at: string | null }
    | undefined;
  const followupCount = Number(followupSummary?.count ?? 0);
  if (!Number.isFinite(basisTime))
    return fingerprintEvaluation({
      ruleId: rule.id,
      status: "blocked_missing_evidence" as const,
      dueAt: null,
      graceUntil: null,
      nextFollowupAt: null,
      followupCount,
      evidence: {
        rule,
        ...calendarEvidence,
        reason: `缺少 ${rule.deadlineBasis === "rihd" ? "RIHD / 要求到货日" : "不可变阶段进入事件"} 证据`,
        basisSource,
        stageEntryEvent: null,
        riskFactors: item.riskFactors,
        leadTimeEvidence: item.leadTimeEvidence ?? [],
        poVersion: poRow.version,
      },
    });
  const dueTime = addSlaCalendarHours(
    basisTime,
    rule.targetOffsetHours,
    calendar,
  );
  const graceTime = addSlaCalendarHours(dueTime, rule.graceHours, calendar);
  const escalationTime = addSlaCalendarHours(
    basisTime,
    rule.escalationAfterHours,
    calendar,
  );
  const warningTime = addSlaCalendarHours(
    dueTime,
    -rule.warningHours,
    calendar,
  );
  const nowTime = now.getTime();
  const status: SlaEvaluationStatus =
    nowTime < warningTime
      ? "on_track"
      : nowTime <= dueTime
        ? "due_soon"
        : nowTime <= graceTime
          ? "in_grace"
          : nowTime >= escalationTime ||
              (rule.maxFollowups > 0 && followupCount >= rule.maxFollowups)
            ? "escalated"
            : "breached";
  const lastFollowupTime = followupSummary?.last_sent_at
    ? Date.parse(followupSummary.last_sent_at)
    : Number.NaN;
  const nextFollowupTime =
    status === "breached" || status === "escalated"
      ? followupCount > 0 && Number.isFinite(lastFollowupTime)
        ? addSlaCalendarHours(
            lastFollowupTime,
            rule.followupIntervalHours,
            calendar,
          )
        : dueTime
      : dueTime;
  return fingerprintEvaluation({
    ruleId: rule.id,
    status,
    dueAt: new Date(dueTime).toISOString(),
    graceUntil: new Date(graceTime).toISOString(),
    nextFollowupAt: new Date(nextFollowupTime).toISOString(),
    followupCount,
    evidence: {
      slaPolicyId: policy.id,
      slaPolicyVersion: policy.version,
      slaRuleId: rule.id,
      ruleName: rule.name,
      route: item.route,
      stage: item.stage,
      risk: item.risk,
      riskPublicationState: item.riskPublicationState,
      deadlineBasis: rule.deadlineBasis,
      basisAt: new Date(basisTime).toISOString(),
      basisSource,
      stageEntryEvent: stageEntry,
      ...calendarEvidence,
      targetOffsetHours: rule.targetOffsetHours,
      warningHours: rule.warningHours,
      graceHours: rule.graceHours,
      escalationAfterHours: rule.escalationAfterHours,
      escalationAt: new Date(escalationTime).toISOString(),
      followupIntervalHours: rule.followupIntervalHours,
      maxFollowups: rule.maxFollowups,
      escalationRole: rule.escalationRole,
      lastFollowupAt: Number.isFinite(lastFollowupTime)
        ? new Date(lastFollowupTime).toISOString()
        : null,
      messageCategory: rule.messageCategory,
      communicationChannel: rule.communicationChannel,
      poVersion: poRow.version,
      riskFactors: item.riskFactors,
      leadTimeEvidence: item.leadTimeEvidence ?? [],
    },
  });
}

function exactStageEntryEvidence(
  db: DatabaseSync,
  tenantId: string,
  poId: string,
  stage: SlaStage,
): {
  eventId: string;
  eventType: string;
  occurredAt: string;
  sourceKind: string;
  sourceId: string;
} | null {
  const row = db
    .prepare(
      `SELECT id,event_type,occurred_at,source_kind,source_id
    FROM procurement_po_stage_events
    WHERE tenant_id=? AND po_id=? AND stage=?
      AND json_extract(evidence_json,'$.exactTransitionTime')=1
    ORDER BY occurred_at ASC,
      CASE event_type WHEN 'stage_entered' THEN 0 ELSE 1 END,
      id ASC LIMIT 1`,
    )
    .get(tenantId, poId, stage) as
    | {
        id: string;
        event_type: string;
        occurred_at: string;
        source_kind: string;
        source_id: string;
      }
    | undefined;
  return row
    ? {
        eventId: row.id,
        eventType: row.event_type,
        occurredAt: row.occurred_at,
        sourceKind: row.source_kind,
        sourceId: row.source_id,
      }
    : null;
}

function fingerprintEvaluation<
  T extends {
    ruleId: string | null;
    status: SlaEvaluationStatus;
    dueAt: string | null;
    graceUntil: string | null;
    nextFollowupAt: string | null;
    followupCount: number;
    evidence: Record<string, unknown>;
  },
>(value: T): T & { fingerprint: string } {
  return {
    ...value,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex"),
  };
}
function matchRule(rules: SlaRule[], item: PortfolioItem): SlaRule | undefined {
  return rules
    .filter(
      (rule) =>
        rule.stage === item.stage &&
        (rule.route === "all" || rule.route === item.route) &&
        (rule.risk === "all" || (item.riskPublicationState === "published" && rule.risk === item.risk)),
    )
    .sort((left, right) => specificity(right) - specificity(left))[0];
}
function specificity(rule: SlaRule): number {
  return (rule.route === "all" ? 0 : 2) + (rule.risk === "all" ? 0 : 1);
}

function tenantWorkingCalendar(
  db: DatabaseSync,
  tenantId: string,
  anchor: number | Date = Date.now(),
): SlaCalendarSnapshot {
  const stored = getProcurementTenantPreferences(db, tenantId);
  const effective = effectiveProcurementTenantPreferences(db, tenantId);
  const holidays = effective.excludePublicHolidays
    ? procurementPublicHolidaySnapshot(effective.countryCode, anchor)
    : null;
  return {
    mode: "tenant_working_days",
    timeZone: effective.timeZone,
    workingDays: effectiveProcurementWorkingDays(effective),
    preferenceVersion: stored?.version ?? null,
    inheritedDefault: !stored,
    excludeWeekends: effective.excludeWeekends,
    excludePublicHolidays: effective.excludePublicHolidays,
    holidayDates: holidays?.dates ?? [],
    holidayCountryCode: holidays?.countryCode ?? null,
    holidayYears: holidays?.years ?? null,
    holidaySource: holidays?.source ?? null,
    holidaySourceVersion: holidays?.sourceVersion ?? null,
    holidaySourceLicense: holidays?.sourceLicense ?? null,
  };
}

function slaCalendarForRule(
  db: DatabaseSync,
  tenantId: string,
  mode: SlaCalendarMode,
  anchor: number | Date = Date.now(),
): SlaCalendarSnapshot {
  return mode === "tenant_working_days"
    ? tenantWorkingCalendar(db, tenantId, anchor)
    : {
        mode: "elapsed_hours",
        timeZone: null,
        workingDays: null,
        preferenceVersion: null,
        inheritedDefault: null,
        excludeWeekends: null,
        excludePublicHolidays: null,
        holidayDates: null,
        holidayCountryCode: null,
        holidayYears: null,
        holidaySource: null,
        holidaySourceVersion: null,
        holidaySourceLicense: null,
      };
}

function presentCalendarEvidence(
  calendar: SlaCalendarSnapshot,
): Record<string, unknown> {
  return {
    calendarMode: calendar.mode,
    calendarTimeZone: calendar.timeZone,
    calendarWorkingDays: calendar.workingDays,
    calendarPreferenceVersion: calendar.preferenceVersion,
    calendarInheritedDefault: calendar.inheritedDefault,
    calendarExcludeWeekends: calendar.excludeWeekends ?? null,
    calendarExcludePublicHolidays: calendar.excludePublicHolidays ?? null,
    calendarHolidayDates: calendar.holidayDates ?? null,
    calendarHolidayCountryCode: calendar.holidayCountryCode ?? null,
    calendarHolidayYears: calendar.holidayYears ?? null,
    calendarHolidaySource: calendar.holidaySource ?? null,
    calendarHolidaySourceVersion: calendar.holidaySourceVersion ?? null,
    calendarHolidaySourceLicense: calendar.holidaySourceLicense ?? null,
  };
}

function listPolicies(db: DatabaseSync, tenantId: string) {
  return (
    db
      .prepare(
        `SELECT * FROM procurement_sla_policies WHERE tenant_id=? ORDER BY CASE status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,updated_at DESC,id`,
      )
      .all(tenantId) as unknown as PolicyRow[]
  ).map(presentPolicy);
}
function listEvaluations(db: DatabaseSync, tenantId: string) {
  const supplierRows = db
    .prepare(
      `SELECT id,json FROM procurement_documents WHERE tenant_id=? AND kind='supplier'`,
    )
    .all(tenantId) as Array<{ id: string; json: string }>;
  const supplierNames = new Map(
    supplierRows.map(
      (row) =>
        [
          row.id,
          String(
            (safeJson(row.json) as Record<string, unknown>)["name"] ?? row.id,
          ),
        ] as const,
    ),
  );
  return (
    db
      .prepare(
        `SELECT e.*,p.name AS policy_name,d.json AS po_json FROM procurement_sla_evaluations e
    JOIN procurement_sla_policies p ON p.tenant_id=e.tenant_id AND p.id=e.policy_id
    LEFT JOIN procurement_documents d ON d.tenant_id=e.tenant_id AND d.id=e.po_id AND d.kind='purchase_order'
    WHERE e.tenant_id=? ORDER BY CASE e.status WHEN 'escalated' THEN 0 WHEN 'breached' THEN 1 WHEN 'in_grace' THEN 2 WHEN 'due_soon' THEN 3 WHEN 'blocked_missing_evidence' THEN 4 WHEN 'unmatched' THEN 5 ELSE 6 END,e.due_at,e.po_id`,
      )
      .all(tenantId) as unknown as Array<
      EvaluationRow & { policy_name: string; po_json: string | null }
    >
  ).map((row) => {
    const po = row.po_json
      ? (safeJson(row.po_json) as Record<string, unknown>)
      : {};
    const supplierId =
      typeof po["supplierId"] === "string" ? po["supplierId"] : null;
    return {
      ...presentEvaluation(row),
      purchaseOrderNumber: po["number"] ?? po["externalId"] ?? row.po_id,
      supplierId,
      supplierName: supplierId
        ? (supplierNames.get(supplierId) ?? supplierId)
        : null,
      policyName: row.policy_name,
    };
  });
}
function listEvaluationEvents(db: DatabaseSync, tenantId: string) {
  const rows = db
    .prepare(
      `SELECT id,po_id,policy_id,rule_id,action,detail_json,created_at
    FROM procurement_sla_evaluation_events
    WHERE tenant_id=?
    ORDER BY created_at DESC,rowid DESC
    LIMIT 100`,
    )
    .all(tenantId) as Array<{
    id: string;
    po_id: string;
    policy_id: string;
    rule_id: string | null;
    action: string;
    detail_json: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    purchaseOrderId: row.po_id,
    policyId: row.policy_id,
    ruleId: row.rule_id,
    action: row.action,
    detail: safeJson(row.detail_json),
    createdAt: row.created_at,
  }));
}
function presentEvaluation(row: EvaluationRow) {
  return {
    purchaseOrderId: row.po_id,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    ruleId: row.rule_id,
    stage: row.stage,
    status: row.status,
    dueAt: row.due_at,
    graceUntil: row.grace_until,
    nextFollowupAt: row.next_followup_at,
    followupCount: row.followup_count,
    evidence: safeJson(row.evidence_json),
    fingerprint: row.fingerprint,
    version: row.version,
    evaluatedAt: row.evaluated_at,
    updatedAt: row.updated_at,
  };
}
function getEvaluation(
  db: DatabaseSync,
  tenantId: string,
  poId: string,
): EvaluationRow | undefined {
  return db
    .prepare(
      `SELECT * FROM procurement_sla_evaluations WHERE tenant_id=? AND po_id=?`,
    )
    .get(tenantId, poId) as unknown as EvaluationRow | undefined;
}
function getPolicy(
  db: DatabaseSync,
  tenantId: string,
  id: string,
): PolicyRow | undefined {
  return db
    .prepare(
      `SELECT * FROM procurement_sla_policies WHERE tenant_id=? AND id=?`,
    )
    .get(tenantId, id) as unknown as PolicyRow | undefined;
}
function presentPolicy(row: PolicyRow) {
  const rules = parseRules(row.rules_json);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
    rules,
    directoryRules: rules.map((rule) => ({
      id: rule.id,
      processStage: rule.name,
      description: rule.description,
      slaTargetDays: rule.targetOffsetHours / 24,
      gracePeriodDays: rule.graceHours / 24,
      escalationAfterDays: rule.escalationAfterHours / 24,
      appliesTo: rule.route,
      appliesToLabel:
        rule.route === "all"
          ? "All Suppliers"
          : rule.route === "local"
            ? "Local Suppliers"
            : rule.route === "import"
              ? "Import Suppliers"
              : "Unclassified Suppliers",
      status: rule.enabled ? "active" : "inactive",
      advanced: {
        stage: rule.stage,
        risk: rule.risk,
        route: rule.route,
        deadlineBasis: rule.deadlineBasis,
        calendarMode: rule.calendarMode,
        warningHours: rule.warningHours,
        followupIntervalHours: rule.followupIntervalHours,
        maxFollowups: rule.maxFollowups,
        escalationRole: rule.escalationRole,
        messageCategory: rule.messageCategory,
        communicationChannel: rule.communicationChannel,
      },
    })),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    publishedBy: row.published_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}
function insertPolicyEvent(
  db: DatabaseSync,
  tenantId: string,
  policyId: string,
  actorId: string,
  action: string,
  detail: unknown,
  at: string,
): void {
  db.prepare(
    `INSERT INTO procurement_sla_policy_events (tenant_id,id,policy_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(
    tenantId,
    `procurement-sla-policy-event:${randomUUID()}`,
    policyId,
    actorId,
    action,
    JSON.stringify(detail),
    at,
  );
}

function validateRules(value: unknown): SlaRule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw new SlaInputError("rules 必须包含 1 到 100 条规则");
  const ids = new Set<string>();
  const matchKeys = new Set<string>();
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new SlaInputError(`第 ${index + 1} 条规则无效`);
    const item = candidate as Record<string, unknown>;
    assertOnlyKeys(item, [
      "id",
      "name",
      "description",
      "enabled",
      "route",
      "stage",
      "risk",
      "deadlineBasis",
      "calendarMode",
      "targetOffsetHours",
      "warningHours",
      "graceHours",
      "escalationAfterHours",
      "followupIntervalHours",
      "maxFollowups",
      "escalationRole",
      "messageCategory",
      "communicationChannel",
    ]);
    const messageCategory = enumValue(
      item["messageCategory"],
      categories,
      `rules[${index}].messageCategory`,
    );
    const targetOffsetHours = boundedNumber(
      item["targetOffsetHours"],
      -8760,
      8760,
      `rules[${index}].targetOffsetHours`,
    );
    const graceHours = boundedNumber(
      item["graceHours"],
      0,
      720,
      `rules[${index}].graceHours`,
    );
    const rule: SlaRule = {
      id: requiredText(item["id"], `rules[${index}].id`, 100),
      name: requiredText(item["name"], `rules[${index}].name`, 120),
      description:
        item["description"] === undefined
          ? categoryDescriptions[messageCategory]
          : requiredText(
              item["description"],
              `rules[${index}].description`,
              240,
            ),
      enabled: booleanValue(item["enabled"], `rules[${index}].enabled`),
      route: enumValue(item["route"], routes, `rules[${index}].route`),
      stage: enumValue(item["stage"], stages, `rules[${index}].stage`),
      risk: enumValue(item["risk"], risks, `rules[${index}].risk`),
      deadlineBasis: enumValue(
        item["deadlineBasis"],
        bases,
        `rules[${index}].deadlineBasis`,
      ),
      calendarMode:
        item["calendarMode"] === undefined
          ? "elapsed_hours"
          : enumValue(
              item["calendarMode"],
              calendarModes,
              `rules[${index}].calendarMode`,
            ),
      targetOffsetHours,
      warningHours: boundedNumber(
        item["warningHours"],
        0,
        8760,
        `rules[${index}].warningHours`,
      ),
      graceHours,
      escalationAfterHours:
        item["escalationAfterHours"] === undefined
          ? targetOffsetHours + graceHours
          : boundedNumber(
              item["escalationAfterHours"],
              -8760,
              9480,
              `rules[${index}].escalationAfterHours`,
            ),
      followupIntervalHours: boundedNumber(
        item["followupIntervalHours"],
        1,
        720,
        `rules[${index}].followupIntervalHours`,
      ),
      maxFollowups: boundedInteger(
        item["maxFollowups"],
        0,
        20,
        `rules[${index}].maxFollowups`,
      ),
      escalationRole: requiredText(
        item["escalationRole"],
        `rules[${index}].escalationRole`,
        100,
      ),
      messageCategory,
      communicationChannel:
        item["communicationChannel"] === undefined
          ? "email"
          : enumValue(
              item["communicationChannel"],
              communicationChannels,
              `rules[${index}].communicationChannel`,
            ),
    };
    if (
      rule.escalationAfterHours <
      rule.targetOffsetHours + rule.graceHours
    )
      throw new SlaInputError(
        `rules[${index}].escalationAfterHours 不得早于 SLA 目标与宽限期之和`,
      );
    if (ids.has(rule.id)) throw new SlaInputError(`规则 ID 重复: ${rule.id}`);
    ids.add(rule.id);
    const matchKey = `${rule.route}:${rule.stage}:${rule.risk}`;
    if (rule.enabled && matchKeys.has(matchKey))
      throw new SlaInputError(`启用规则匹配条件重复: ${matchKey}`);
    if (rule.enabled) matchKeys.add(matchKey);
    return rule;
  });
}
function parseRules(raw: string): SlaRule[] {
  return validateRules(safeJson(raw));
}
async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 500_000) throw new SlaInputError("请求体过大");
  }
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new SlaInputError("请求体必须是 JSON 对象");
  }
}
function assertOnlyKeys(value: Record<string, unknown>, keys: string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new SlaInputError(`不允许的字段: ${key}`);
}
function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new SlaInputError(`${field} 必填`);
  if (value.trim().length > max)
    throw new SlaInputError(`${field} 超过 ${max} 字符`);
  return value.trim();
}
function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length > max)
    throw new SlaInputError("文本字段无效");
  return value.trim();
}
function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new SlaInputError(`${field} 必须是正整数`);
  return Number(value);
}
function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  field: string,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new SlaInputError(`${field} 必须是 ${min} 到 ${max} 的整数`);
  return Number(value);
}
function boundedNumber(
  value: unknown,
  min: number,
  max: number,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new SlaInputError(`${field} 必须是 ${min} 到 ${max} 的数字`);
  return value;
}
function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean")
    throw new SlaInputError(`${field} 必须是布尔值`);
  return value;
}
function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new SlaInputError(`${field} 无效`);
  return value as T;
}
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}
function decodePath(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 300) throw new Error();
    return decoded;
  } catch {
    throw new SlaInputError("SLA 策略 ID 无效");
  }
}
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function forbidden(res: ServerResponse, message: string): true {
  sendJson(res, 403, { error: message, code: "FORBIDDEN" });
  return true;
}
function sendSlaError(res: ServerResponse, error: unknown): void {
  if (error instanceof SlaNotFoundError)
    return sendJson(res, 404, {
      error: error.message,
      code: "SLA_POLICY_NOT_FOUND",
    });
  if (error instanceof SlaVersionError)
    return sendJson(res, 409, {
      error: error.message,
      code: "SLA_VERSION_CONFLICT",
      currentVersion: error.currentVersion,
    });
  if (error instanceof SlaStateError)
    return sendJson(res, 409, {
      error: error.message,
      code: "SLA_STATE_CONFLICT",
    });
  if (error instanceof SlaInputError)
    return sendJson(res, 422, {
      error: error.message,
      code: "INVALID_SLA_INPUT",
    });
  throw error;
}
class SlaInputError extends Error {}
class SlaStateError extends Error {}
class SlaNotFoundError extends Error {
  constructor() {
    super("SLA 策略不存在");
  }
}
class SlaVersionError extends Error {
  constructor(readonly currentVersion: number) {
    super(`SLA 策略版本已变更，当前版本为 ${currentVersion}`);
  }
}
