import assert from "node:assert/strict";
import { test } from "node:test";
import { routeMaterialTypeLabel, routeRiskReason, routeStageLabel, type PortfolioRiskFactor } from "../features/procurement/route-workbench-view-model.js";

function factor(code: string, score = 80): PortfolioRiskFactor {
  return { code, label: `source:${code}`, score, evidence: `evidence:${code}` };
}

test("route risk reason presents the highest persisted factor with a Chinese operational label", () => {
  const cases: Array<[string, string]> = [
    ["supplier_no_response", "未获承诺"],
    ["rihd_overdue", "RIHD 逾期"],
    ["manufacturing_lead_time_shortfall", "交期风险"],
    ["approval_pending", "待审批"],
    ["production_delayed", "生产延误"],
    ["production_blocked", "生产受阻"],
    ["connector_failed", "执行失败"],
    ["transport_exception", "运输异常"],
    ["customs_held", "清关滞留"],
    ["shipment_eta_overdue", "ETA 逾期"],
    ["import_documents:missing", "单证风险"],
    ["exception:manual_purchase_order_risk", "人工风险"],
    ["exception:three_way_match", "业务异常"],
    ["new_backend_factor", "source:new_backend_factor"],
  ];

  for (const [code, expected] of cases) {
    assert.equal(routeRiskReason([factor(code)]), expected, code);
  }
  assert.equal(routeRiskReason([]), null);
  assert.equal(
    routeRiskReason([factor("supplier_no_response", 55), factor("transport_exception", 90)]),
    "运输异常",
  );
  assert.equal(routeRiskReason([{ ...factor("custom_vendor_hold"), label: "Pending" }]), "Pending");
  assert.equal(routeRiskReason([{ ...factor("custom_vendor_hold"), label: "" }]), "业务风险");
});

test("route display labels translate known enums and preserve unknown business values", () => {
  assert.equal(routeStageLabel("po_sent", "PO Sent"), "采购订单已发送");
  assert.equal(routeStageLabel("supplier_commitment", "Supplier Commitment"), "供应商承诺");
  assert.equal(routeStageLabel("completed", "Completed"), "已完成");
  assert.equal(routeStageLabel("custom_stage", "Vendor Custom Gate"), "Vendor Custom Gate");
  assert.equal(routeMaterialTypeLabel("Direct"), "直接物料");
  assert.equal(routeMaterialTypeLabel("Indirect"), "间接物料");
  assert.equal(routeMaterialTypeLabel("Custom Blend"), "Custom Blend");
});
