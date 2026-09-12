import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { procurementHeaderPresentation } from "../features/procurement/visual-tokens.js";

const source = readFileSync(
  fileURLToPath(new URL("../features/procurement/notifications.tsx", import.meta.url)),
  "utf8",
);

test("Notifications Web: 页面加载、筛选和实时刷新保持纯读取", () => {
  assert.doesNotMatch(source, /notifications\/refresh/);
  assert.doesNotMatch(source, /runRules/);
  assert.match(source, /api\/procurement\/notifications\?filter=/);
  assert.match(source, /notifications\/\$\{encodeURIComponent\(item\.id\)\}\/read`, \{ method: "POST", body: \{ expectedVersion: item\.version \} \}/);
  assert.match(source, /notifications\/read-all", \{ method: "POST" \}/);
  assert.match(source, /onClick=\{\(\) => void openNotification\(item\)\}/);
  assert.match(source, /onClick=\{\(\) => void markAllRead\(\)\}/);
});

test("Notifications Web: 使用集成页头且不显示全局搜索", () => {
  assert.deepEqual(procurementHeaderPresentation({ section: "notifications", purchaseOrderId: null }), { integrated: true, showSearch: false });
});
