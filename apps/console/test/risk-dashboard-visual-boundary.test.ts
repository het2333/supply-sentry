import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { procurementHeaderPresentation } from "../features/procurement/visual-tokens.js";

const source = readFileSync(
  fileURLToPath(new URL("../features/procurement/risk-dashboard.tsx", import.meta.url)),
  "utf8",
);
const apiSource = readFileSync(
  fileURLToPath(new URL("../../api/src/procurement-risk-dashboard.ts", import.meta.url)),
  "utf8",
);

test("Risk Dashboard Web: risk page keeps its integrated header", () => {
  assert.deepEqual(procurementHeaderPresentation({ section: "risk-dashboard", purchaseOrderId: null }), { integrated: true, showSearch: false });
});

test("Risk Dashboard Web: seven analytical headings match the reference 15px/600 density", () => {
  assert.match(source, /const RISK_ANALYTICAL_HEADING_CLASS = "text-\[15px\] font-semibold text-\[#242b38\]"/);
  assert.equal(source.match(/className=\{RISK_ANALYTICAL_HEADING_CLASS\}/g)?.length, 7);
  assert.doesNotMatch(source, /text-\[17px\]/);
});


test("Risk Dashboard Web: PO 明细使用不可变快照字段和真实对象深链", () => {
  assert.match(apiSource, /requiredInHouseAt: item\.requiredInHouseAt/);
  assert.match(apiSource, /nextAction: item\.nextAction/);
  assert.match(apiSource, /riskFactors: item\.riskFactors/);
  assert.match(source, /onOpenPurchaseOrder\(row\.original\.purchaseOrderId\)/);
  assert.match(source, /row\.original\.riskFactors \?\? \[\]/);
  assert.doesNotMatch(source, /ACME|PO-2026-001|\$1\.25M/);
});

test("Risk Dashboard Web: 历史快照缺字段时诚实空缺，不用当前 PO 伪造过去", () => {
  assert.match(source, /row\.original\.requiredInHouseAt \? formatDate/);
  assert.match(source, /row\.original\.nextAction \|\| "—"/);
});

test("Risk Dashboard Web: 供应商行不会把 provisional 或未发布分数伪装成正式风险", () => {
  assert.match(source, /supplierRiskPresentation\(supplier\.riskScore, supplier\.purchaseOrders, supplierOrders\)/);
  assert.match(source, /presentation\.stateLabel/);
  assert.match(source, /presentation\.missingLabel/);
  assert.match(source, /presentation\.score/);
});
