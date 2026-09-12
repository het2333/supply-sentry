import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { procurementHeaderPresentation } from "../features/procurement/visual-tokens.js";

const source = readFileSync(
  fileURLToPath(new URL("../features/procurement/message-drafts.tsx", import.meta.url)),
  "utf8",
);

test("Drafted Emails Web: 官网桌面双卡骨架与集成页头", () => {
  assert.match(source, /h-\[124\.25px\]/);
  assert.match(source, /READYWORK_PAGE_TITLE_CLASS, "leading-\[1\.5\] text-\[#0f1729\]"/);
  assert.match(source, /grid grid-cols-1 gap-5 lg:grid-cols-\[minmax\(0,380px\)_minmax\(0,1fr\)\]/);
  assert.match(source, /draft-list overflow-hidden rounded-3xl border border-\[#eef2f6\] bg-white/);
  assert.match(source, /min-w-0 rounded-3xl border border-\[#eef2f6\] bg-white p-6/);
  assert.deepEqual(procurementHeaderPresentation({ section: "message-drafts", purchaseOrderId: null }), { integrated: true, showSearch: false });
});

test("Drafted Emails Web: 编辑器提交完整的收件人合同并保留原始输入", () => {
  assert.match(source, /const \[recipient, setRecipient\] = useState\(""\)/);
  assert.match(source, /const \[editReason, setEditReason\] = useState\(""\)/);
  assert.match(source, /body: \{ expectedVersion: selected\.version, recipient, subject, body, reason: editReason \}/);
  assert.match(source, /<form aria-labelledby="edit-draft-title"/);
  // System labels and accessible fields are exercised by the real React editor test.
  assert.doesNotMatch(source, /@radix-ui\/react-dialog/);
  assert.match(source, /!recipient\.trim\(\).*?!subject\.trim\(\).*?!body\.trim\(\).*?!editReason\.trim\(\)/);
});

test("Drafted Emails Web: 只有真实回执成功才显示 Sent", () => {
  assert.match(source, /draft\.status === "sent" && draft\.delivery\?\.status === "dispatched"/);
  // Persisted delivery-state labels are asserted on rendered rows, without the localization observer.
  assert.doesNotMatch(source, /const statusLabel:[^\n]+sent:/);
});

test("Drafted Emails Web: 真实外发动作仍经过现有 API", () => {
  assert.match(source, /api\/procurement\/message-drafts\/\$\{encodeURIComponent\(selected\.id\)\}\/approve/);
  assert.match(source, /api\/procurement\/message-drafts\/\$\{encodeURIComponent\(selected\.id\)\}\/discard/);
});
