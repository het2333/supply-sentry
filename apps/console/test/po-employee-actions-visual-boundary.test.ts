import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = readFileSync(
  fileURLToPath(new URL("../features/procurement/po-employee.tsx", import.meta.url)),
  "utf8",
);
const documentSource = readFileSync(
  fileURLToPath(new URL("../features/procurement/po-print-view.tsx", import.meta.url)),
  "utf8",
);

test("PO 详情 Actions: 保持 180px 的五项菜单与 560px 复制弹窗", () => {
  assert.match(source, /aria-haspopup="menu"/);
  assert.match(source, /aria-expanded=\{actionsMenuOpen\}/);
  assert.match(source, />操作<ChevronDown/);
  assert.match(source, /role="menu"/);
  assert.match(source, />复制订单<\/button>/);
  assert.match(source, /w-\[180px\]/);
  assert.match(source, /max-w-\[560px\]/);
  assert.match(source, /aria-labelledby="duplicate-po-title"/);
  assert.match(source, /detail\?\.actionReadiness\?\.duplicate_po\?\.ready !== true/);
});

test("PO 文档快照: Download 和 Print 走服务器快照并在生成失败时不展示成功", () => {
  assert.match(documentSource, /purchase-orders\/\$\{encodeURIComponent\(purchaseOrderId\)\}\/document-snapshots/);
  assert.match(documentSource, /purpose === "download"/);
  assert.match(documentSource, /purpose === "download" \? result\.pdfUrl : result\.printUrl/);
  assert.match(source, /正在生成 PDF…/);
  assert.match(source, /正在生成打印视图…/);
  assert.match(documentSource, /window\.open\(/);
  assert.match(documentSource, /windowTarget\?\.close\(\)/);
  assert.match(source, /alert\(/);
  assert.doesNotMatch(source, /outerHTML|innerHTML|document\.documentElement/);
});

test("PO 编辑: 使用 Radix 560px Dialog、供应商 ID 和版本冲突恢复", () => {
  assert.match(source, /import \* as Dialog from "@radix-ui\/react-dialog"/);
  assert.match(source, /<Dialog\.Root open=\{editForm !== null\}/);
  assert.match(source, /max-w-\[560px\]/);
  assert.match(source, /w-\[180px\]/);
  const edit = source.indexOf(">编辑采购订单<");
  const duplicate = source.indexOf(">复制订单<");
  const download = source.indexOf(">下载 PDF<");
  const print = source.indexOf(">打印<");
  const cancel = source.indexOf(">取消采购订单<");
  assert.ok(edit >= 0 && edit < duplicate && duplicate < download && download < print && print < cancel, "PO Actions keeps the approved order");
  assert.match(source, /buildEditPurchaseOrderPatch\(editForm\.baseline, editForm, \{ external: editForm\.external \}\)/);
  assert.match(source, /仅 RIHD 可通过权威 Odoo 写入与读回修改/);
  assert.doesNotMatch(source, /supplierName:\s*editForm/);
  assert.match(source, /currentVersion/);
  assert.match(source, /serverVersion: serverVersion \?\? current\.serverVersion/);
});

test("PO 复制: 走真实 API、版本、幂等和刷新后打开新 Draft", () => {
  assert.match(source, /api\/procurement\/execution\/duplicate_po/);
  assert.match(source, /"Idempotency-Key": duplicateForm\.idempotencyKey/);
  assert.match(source, /expectedVersion: duplicateForm\.expectedVersion/);
  assert.match(source, /purchaseOrderNumber: newPurchaseOrderNumber/);
  assert.match(source, /requiredInHouseAt: duplicateForm\.newRequiredInHouseAt/);
  assert.match(source, /rows\(result\.createdDocuments\).*sourceSystem === "readywork".*status === "draft"/);
  assert.match(source, /const refreshed = await loadWorkbench\(false, 30_000\)/);
  assert.match(source, /createdInWorkbench/);
  assert.match(source, /工作台尚未读回该记录/);
  assert.match(source, /setSelectedId\(createdId\)/);
  assert.match(source, /onPurchaseOrderNavigationChange\?\.\(createdId, "overview"\)/);
  assert.ok(source.indexOf("const refreshed = await loadWorkbench(false, 30_000)") < source.indexOf("setDuplicateForm(null)"), "权威工作台读回前不能关闭复制弹窗");
});

test("PO 复制: 文案与实际副作用边界一致", () => {
  assert.match(source, /新编号必须在当前租户内唯一/);
  assert.match(source, /复制原因至少需要 4 个字符/);
  assert.match(source, /不会继承/);
  assert.match(source, /Odoo 映射、RFQ \/ Award \/ 采购需求关系、附件/);
  assert.match(source, /不发邮件、不写 Odoo、不推进源 PO/);
  assert.doesNotMatch(source, /setTimeout\([^)]*PO Draft/);
});

// Six-tab rendering, filter recovery, supplier absence and thread selection are
// exercised by po-detail-reference-states-interaction.test.tsx against React.
