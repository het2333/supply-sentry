import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { procurementHeaderPresentation } from "../features/procurement/visual-tokens.js";

const source = readFileSync(
  fileURLToPath(new URL("../features/procurement/route-workbench.tsx", import.meta.url)),
  "utf8",
);
const controlsSource = readFileSync(
  fileURLToPath(new URL("../features/procurement/route-workbench-controls.tsx", import.meta.url)),
  "utf8",
);

test("Local / Import Web: 使用 Navisight 桌面双栏路线工作台", () => {
  assert.match(source, /grid-cols-\[380px_minmax\(0,1fr\)\]/);
  assert.match(source, /h-\[calc\(100vh-176px\)\]/);
  assert.match(source, /sticky top-\[100px\]/);
  assert.match(source, /min-w-\[1140px\]/);
  assert.match(source, /const PAGE_SIZE = 10/);
  assert.doesNotMatch(source, /<RouteRiskOverview/);
  assert.doesNotMatch(source, /metricCards/);
  assert.doesNotMatch(source, /<ImportDocumentsPanel/);
});

test("Local / Import Web: 主表冻结为十列并通过服务端权威导出", () => {
  const expectedColumns = ["采购订单号", "供应商", "物料类型", "当前阶段", "要求到货日期（RIHD）", "距 RIHD 天数", "风险", "下一步操作", "总金额"];
  const headerStart = source.indexOf("<thead>");
  const headerEnd = source.indexOf("</thead>", headerStart);
  const header = source.slice(headerStart, headerEnd);
  assert.ok(headerStart >= 0 && headerEnd > headerStart, "应存在主表表头");
  assert.deepEqual(expectedColumns.map((column) => header.includes(`>${column}<`) || header.includes(`aria-label=\"${column}\"`)), expectedColumns.map(() => true));
  assert.equal((header.match(/<th\b/gu) ?? []).length, 10);
  assert.match(header, /<th aria-label="行操作"[^>]*\/>/);
  assert.doesNotMatch(header, />行操作</);
  assert.doesNotMatch(header, /运输事实|ETA \/ 收货|ETA \/ 清关 \/ 单证|路线证据/u);
  assert.match(source, /api\/procurement\/routes\/\$\{route\}\/exports/);
  assert.match(source, /supplierIds/);
  assert.match(source, /Idempotency-Key/);
  assert.doesNotMatch(source, /new Blob\(/);
  assert.doesNotMatch(source, /URL\.createObjectURL/);
});

test("Local / Import Web: PO 行尾跟进动作只生成可审核的真实草稿", () => {
  assert.match(controlsSource, />发送跟进<\/button>/);
  assert.match(source, /api\/procurement\/execution\/queue_followup/);
  assert.match(source, /Idempotency-Key/);
  assert.match(source, /expectedVersion: followupTarget\.version/);
  assert.match(source, /不发邮件、不写 Odoo、不推进 PO 阶段/);
  assert.match(source, /前往草稿邮件/);
});

test("Local / Import Web: 行菜单标签与参考平台一致，风险入口受服务端 readiness 与统一审计合同约束", () => {
  const menu = controlsSource.slice(controlsSource.indexOf("export function RouteOrderActionsMenu"));
  const detailIndex = menu.indexOf(">查看详情</button>");
  const followupIndex = menu.indexOf(">发送跟进</button>");
  const rihdIndex = menu.indexOf(">修改 RIHD</button>");
  const riskIndex = menu.indexOf(">标记风险</button>");
  assert.ok(detailIndex >= 0 && detailIndex < followupIndex, "操作菜单应先提供查看详情");
  assert.ok(followupIndex < rihdIndex && rihdIndex < riskIndex, "标记风险应保留在既有菜单顺序末尾");
  assert.match(menu, /role="separator"[\s\S]*?role="menuitem"[\s\S]*?className="[^"]*text-red-600[^"]*"[\s\S]*?标记风险<\/button>/);
  assert.match(source, /api\/procurement\/execution\/mark_at_risk/);
  assert.match(source, /expectedVersion: riskTarget\.version/);
  assert.match(source, /riskTarget\.actionReadiness\.mark_at_risk\.ready/);
  assert.match(source, /!riskTarget\.actionReadiness\.mark_at_risk\.ready/);
  assert.match(source, /result\.exception/);
  assert.match(source, /统一异常中心和审计时间线/);
  assert.match(source, /后续处置与关闭必须保留在异常审计链中/);
  assert.match(source, /不发送邮件、不写 Odoo、不改变 PO 执行阶段/);
  assert.match(source, /没有发送邮件、写入 Odoo 或推进 PO 阶段/);
});

test("Local / Import Web: Edit RIHD 等待 Odoo 写后回执，不显示假成功", () => {
  assert.match(controlsSource, />修改 RIHD<\/button>/);
  assert.match(source, /api\/procurement\/execution\/update_rihd/);
  assert.match(source, /expectedVersion: rihdTarget\.version/);
  assert.match(source, /actionReadiness\.update_rihd\.ready/);
  assert.match(source, /页面不会在 Odoo 回执前显示成功/);
  assert.match(source, /purchase\.order\.line\.date_planned/);
  assert.match(source, /只有 Odoo 所有订单行 date_planned 回读一致后/);
  assert.match(source, /api\/procurement\/execution\/outbox/);
});

test("Local / Import Web: Header 集成且不显示官网不存在的全局搜索", () => {
  assert.deepEqual(procurementHeaderPresentation({ section: "local-procurement", purchaseOrderId: null }), { integrated: true, showSearch: false });
  assert.deepEqual(procurementHeaderPresentation({ section: "import-procurement", purchaseOrderId: null }), { integrated: true, showSearch: false });
});

test("Local / Import Web: 真实数据、路线确认和 Odoo 同步仍走既有后端", () => {
  assert.match(source, /api\/procurement\/workbench\?limit=100/);
  assert.match(source, /api\/procurement\/routes\/\$\{encodeURIComponent\(selected\.id\)\}\/assign/);
  assert.match(source, /api\/procurement\/suppliers\/sync/);
  assert.match(source, /这是路线级运营摘要，不是伪造的聊天助手/);
  assert.doesNotMatch(source, /api\/po\/chat/);
});

test("Local / Import Web: 筛选、日期范围、斑马纹和编号分页只作用于真实 PO", () => {
  assert.match(source, /requiredInHouseAt/);
  assert.match(source, /dateFrom/);
  assert.match(source, /dateTo/);
  assert.match(source, />筛选<\/button>/);
  assert.match(controlsSource, /<DayPicker mode="range"/);
  assert.match(controlsSource, /from "react-day-picker\/locale"/);
  assert.match(controlsSource, /最近 7 天/);
  assert.match(source, /nth-child\(even\)/);
  assert.match(source, /pageNumbers\.map/);
  assert.match(source, /显示第 \{filteredItems\.length \?/);
  assert.match(source, /条，共 \{filteredItems\.length\} 条/);
});

test("Local / Import Web: 页头、阶段与工具条对齐已登录参考页", () => {
  assert.match(source, /const title = isLocal \? "本地采购" : "进口采购"/);
  assert.match(source, /管理并跟踪所有本地采购订单/);
  assert.match(source, /搜索采购订单号、供应商…/);
  assert.match(source, /尚无已确认的\$\{title\}订单/);
  for (const label of ["全部采购订单", "采购订单已发送", "供应商承诺", "履约 \/ 生产", "发运", "交付", "已完成"]) {
    assert.match(source, new RegExp(`label: "${label.replace("/", "\\/")}"`));
  }
  assert.match(source, /label: "在途跟踪"/);
  assert.match(source, /label: "交付完成与收货"/);
  for (const label of ["筛选", "导出"]) assert.match(source, new RegExp(`>${label}<`));
  for (const label of ["风险", "供应商"]) assert.match(source, new RegExp(`label="${label}"`));
  assert.match(controlsSource, /"日期范围"/);
  assert.doesNotMatch(source, /stageCounts\[tab\.id\]/);
});
