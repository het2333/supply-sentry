import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const shell = source("../features/marketing/legal-page.tsx");
const privacy = source("../app/privacy/page.tsx");
const terms = source("../app/terms/page.tsx");
const authGate = source("../features/auth/auth-gate.tsx");

test("public legal Web: follows the approved Readywork desktop information architecture", () => {
  assert.match(shell, /min-w-\[1180px\]/);
  assert.match(shell, /sticky top-0/);
  assert.match(shell, /grid-cols-\[280px_minmax\(0,1fr\)\]/);
  assert.match(shell, /aria-label="本页内容"/);
  assert.match(shell, /预发布声明/);
  assert.match(shell, /href="\/product#solution"/);
  assert.match(shell, /href="\/privacy"/);
  assert.match(shell, /href="\/terms"/);
});

test("public legal Web: is reachable without mounting the authenticated procurement workspace", () => {
  assert.match(authGate, /pathname === "\/product" \|\| pathname === "\/privacy" \|\| pathname === "\/terms"/);
});

test("public legal Web: documents current facts without copying another operator's legal identity", () => {
  assert.match(privacy, /演示表单要求填写姓名、工作邮箱和公司/);
  assert.match(privacy, /HttpOnly、SameSite 会话 Cookie/);
  assert.match(privacy, /Readywork 自有本地路径提供，或渲染为本地 React 视觉元素/);
  assert.match(terms, /不会订立合同/);
  assert.match(terms, /第三方组件许可清单/);
  const combined = `${privacy}\n${terms}`;
  assert.doesNotMatch(combined, /navisight(?:\.ai)?|Dubai|Colombo|Sri Lanka|United Arab Emirates|Resend/i);
  assert.match(combined, /运营法律实体|运营实体/);
});
