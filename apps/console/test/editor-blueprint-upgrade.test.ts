import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const page = readFileSync(fileURLToPath(new URL("../app/page.tsx", import.meta.url)), "utf8");

test("desktop Employee Editor: V1 蓝图必须先读取真实差异再显式确认导入", () => {
  assert.match(page, /apiRequest<EditorBlueprintUpgradePreview>\(employeeScopedPath\("\/api\/editor\/blueprint-upgrade"/);
  assert.match(page, /V1 工作流蓝图可导入/);
  assert.match(page, /查看差异并导入/);
  assert.match(page, /确认备份并导入/);
  assert.match(page, /expectedRevisions: blueprintUpgradePreview\.expectedRevisions/);
  assert.match(page, /idempotencyKey: blueprintUpgradeRequestRef\.current/);
});

test("desktop Employee Editor: 蓝图导入文案不得伪装发布或业务副作用", () => {
  assert.match(page, /导入只更新未发布草稿，不会启动流程、发送邮件、写 ERP 或改变正式 PO/);
  assert.match(page, /已备份原草稿并导入 V1 蓝图；尚未发布，也未运行任何业务动作/);
  assert.match(page, /原备份和操作者会写入审计表/);
});
