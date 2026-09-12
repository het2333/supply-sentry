import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = readFileSync(
  fileURLToPath(new URL("../features/procurement/suppliers-workbench.tsx", import.meta.url)),
  "utf8",
);
const pageSource = readFileSync(
  fileURLToPath(new URL("../app/page.tsx", import.meta.url)),
  "utf8",
);

test("Suppliers Web: 主数据、绩效与制造交期全部来自真实 API", () => {
  assert.match(source, /api\/procurement\/suppliers/);
  assert.match(source, /api\/procurement\/supplier-performance/);
  assert.match(source, /api\/po\/lead-times/);
  assert.match(source, /<ProcurementMaterialLeadTimesPanel manageSupplierId=/);
  assert.match(source, /READYWORK_PAGE_TITLE_CLASS/);
  assert.match(source, /<h1 className=\{READYWORK_PAGE_TITLE_CLASS\}>供应商<\/h1>/);
  assert.doesNotMatch(pageSource, /section === "settings" && <ProcurementMaterialLeadTimesPanel/);
});

test("Suppliers Web: 写操作保留幂等键且不会把查看页面伪装成成功", () => {
  assert.match(source, /idempotencyKey: createKey\.current/);
  assert.match(source, /expectedVersion: row\.master\.version/);
  assert.match(source, /expectedProfileVersion: row\.profile\?\.version/);
  assert.match(source, /Promise\.allSettled/);
});
