import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("public product page, demo form, and embedded visuals contain Chinese source content without the runtime translator", () => {
  const source = [
    "../app/product/page.tsx",
    "../app/product/demo-request-form.tsx",
    "../app/product/layout.tsx",
    "../features/marketing/readywork-product-visuals.tsx",
  ]
    .map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"))
    .join("\n");
  for (const expected of [
    "让每张采购订单按计划推进",
    "采购执行 AI",
    "产品",
    "工作原理",
    "风险洞察",
    "客户价值",
    "常见问题",
    "申请演示",
    "姓名 *",
    "工作邮箱 *",
    "公司 *",
    "从限定范围的试点开始",
    "采购总览",
    "待审核邮件",
    "采购订单生命周期",
    "本地采购路线",
    "隐私政策",
    "使用条款",
  ]) assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), expected);

  for (const unexpected of [
    "Product navigation",
    "Keep every PO on track",
    "The problem",
    "The solution",
    "How it works",
    "Risk visibility",
    "Customer value",
    "Manual coordination",
    "Evidence required",
    "No persisted data",
    "Drafted Emails",
    "Risk Dashboard",
    "Frequently asked questions",
    "Request a Demo",
    "Full name",
    "Work email",
    "Privacy Policy",
    "Terms of Use",
  ]) assert.doesNotMatch(source, new RegExp(unexpected, "i"), unexpected);

  assert.match(source, /title: "Readywork 采购执行/);
  assert.match(source, /description: ".*人工/);
});
