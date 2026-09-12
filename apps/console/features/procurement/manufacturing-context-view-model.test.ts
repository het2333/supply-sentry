import assert from "node:assert/strict";
import test from "node:test";
import { manufacturingContextViewModel } from "./manufacturing-context-view-model";

test("context view model keeps missing facts visible and labels observed backfill honestly", () => {
  const model = manufacturingContextViewModel({
    data: { root: { label: "PO-1" }, evidence: [{ sourceSemantics: "observed_backfill", factPath: "purchase_order.status", value: "sent" }] },
    sourceWatermark: "watermark:1", projectionStatus: "current",
    missingFacts: ["odoo_purchase_order", "supplier_confirmation", "production_progress", "shipment", "grn"],
    conflicts: [], truncated: false, nextCursor: null,
  });
  assert.deepEqual(model.missingFacts.map((item) => item.label), ["Odoo 采购订单", "供应商正式确认", "生产 / 备货进度", "发运 / ASN", "最终 GRN"]);
  assert.equal(model.evidence[0]!.sourceLabel, "历史状态观察（非精确迁移时间）");
});

test("context summary counts unique persisted evidence without inventing lifecycle facts", () => {
  const model = manufacturingContextViewModel({
    data: {
      root: { id: "po:1", entityType: "purchase_order", label: "P00021" },
      entities: [
        { id: "po:1", entityType: "purchase_order", label: "P00021" },
        { id: "supplier:1", entityType: "supplier", label: "真实供应商" },
      ],
      relations: [{ id: "relation:1", relationType: "ordered_from", fromEntityId: "po:1", toEntityId: "supplier:1" }],
      evidence: [{ id: "evidence:1", entityId: "po:1", factPath: "purchase_order.status", value: "awaiting_confirmation" }],
      agentEvents: [{ id: "event:1", status: "completed" }],
    },
    sourceWatermark: "watermark:21",
    projectionStatus: "current",
    missingFacts: ["supplier_confirmation", "shipment", "grn"],
    conflicts: [{ factPath: "purchase_order.status", selectedEvidenceId: "evidence:1", conflictingEvidenceIds: ["evidence:0"] }],
    truncated: false,
    nextCursor: null,
  });

  assert.deepEqual(model.summary, {
    entityCount: 2,
    relationCount: 1,
    evidenceCount: 1,
    missingFactCount: 3,
    conflictCount: 1,
    agentEventCount: 1,
  });
  assert.equal(model.projection.label, "当前");
});
