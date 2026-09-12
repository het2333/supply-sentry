import assert from "node:assert/strict";
import test from "node:test";
import { routeEvidenceCoverage, supplierRouteEvidenceSyncMessage } from "./route-evidence-sync";

test("route evidence sync keeps active POs unclassified when Odoo has no eligible fields", () => {
  const items = Array.from({ length: 26 }, () => ({ active: true, route: "unclassified", routeEvidenceCandidates: [] }));
  const coverage = routeEvidenceCoverage(items);
  assert.deepEqual(coverage, { unclassified: 26, eligibleErp: 0, missingErp: 26 });
  assert.equal(
    supplierRouteEvidenceSyncMessage({ created: 0, updated: 0, unchanged: 10, issues: [] }, coverage),
    "Odoo 供应商主数据同步完成：新增 0，更新 0，未变化 10；Odoo 当前仍未提供 PO Incoterm 或供应商国家/地址，26 张 PO 保持未分类。",
  );
});

test("route evidence sync counts only eligible ERP candidates on active unclassified POs", () => {
  const coverage = routeEvidenceCoverage([
    { active: true, route: "unclassified", routeEvidenceCandidates: [{ type: "erp_field", eligible: true }] },
    { active: true, route: "unclassified", routeEvidenceCandidates: [{ type: "route_document", eligible: true }] },
    { active: false, route: "unclassified", routeEvidenceCandidates: [{ type: "erp_field", eligible: true }] },
    { active: true, route: "local", routeEvidenceCandidates: [{ type: "erp_field", eligible: true }] },
  ]);
  assert.deepEqual(coverage, { unclassified: 2, eligibleErp: 1, missingErp: 1 });
  assert.equal(
    supplierRouteEvidenceSyncMessage({ created: 1, updated: 2, unchanged: 7, issues: [{}] }, coverage),
    "Odoo 供应商主数据同步完成：新增 1，更新 2，未变化 7，另有 1 条坏行未写入；1/2 张未分类 PO 现有可用 ERP 路线证据，请逐张由采购经理确认。",
  );
});
