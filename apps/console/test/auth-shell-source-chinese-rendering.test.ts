import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("authentication and the procurement shell contain direct Chinese source labels", () => {
  const source = [
    "../features/auth/auth-gate.tsx",
    "../features/platform/employee-packs.ts",
    "../features/procurement/global-header.tsx",
    "../app/layout.tsx",
  ].map((path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")).join("\n");

  for (const expected of [
    "欢迎回来",
    "正在验证安全会话",
    "企业身份提供方尚未接入",
    "安全会话已过期",
    "采购路径",
    "报表",
    "设置",
    "全局采购搜索",
    "退出登录",
    "lang=\"zh-CN\"",
  ]) assert.match(source, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), expected);

  for (const unexpected of [
    "Welcome back",
    "Sign in",
    "Username",
    "Password",
    "Checking session",
    "Session expired",
    "Procurement Routes",
    "Reports",
    "Sign out",
    "Global search",
  ]) assert.doesNotMatch(source, new RegExp(`[\"'>]${unexpected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\"'<]`), unexpected);
});
