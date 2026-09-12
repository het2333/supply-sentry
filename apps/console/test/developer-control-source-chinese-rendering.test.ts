import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pageSource = readFileSync(fileURLToPath(new URL("../app/page.tsx", import.meta.url)), "utf8");
const packSource = readFileSync(fileURLToPath(new URL("../../../packages/supply-chain/src/procurement-employee-pack.ts", import.meta.url)), "utf8");

test("developer and auxiliary control surfaces use direct Chinese source copy", () => {
  for (const expected of [
    "连接器控制面",
    "V1 生命周期",
    "AI 运行时",
    "节点工厂 · 变量池 · 图校验",
    "工作器 / 技能 / 工具均可拖入画布",
    "输入结构",
    "输出结构",
    "Temporal 运行记录",
    "节点运行时间线",
    "回归测试",
    "版本与发布",
    "运行日志",
    "员工编译器",
    "企业上下文图谱",
    "无服务器",
    "副作用已通过审批门禁",
    "尝试 {nodeRun.attempt}",
    '"advanced-sla": "高级服务等级"',
  ]) assert.ok(pageSource.includes(expected), expected);

  for (const forbidden of [
    ">CONNECTOR CONTROL PLANE<",
    ">V1 Lifecycle<",
    'label: "Editor"',
    'label: "Runs"',
    'label: "Rules"',
    'label: "Tests"',
    'label: "Versions"',
    'label: "Logs"',
    "AI Workforce 运行分布",
    "Enterprise Context Graph 中的实体",
    ">Employee Compiler<",
    ">AI Runtime ",
    ">Node Factory · Variable Pool · 图校验<",
    ">Worker / Skill / Tool 都是可拖入画布的资产<",
    ">Credential<",
    ">Temporal Runs<",
    ">Tests · 回归测试<",
    ">Versions · 版本与发布<",
    ">Logs · 运行日志<",
    "/ Editor</span>",
    ">Edge</Badge>",
    "输入 Schema",
    "输出 Schema",
    "与 Rules 页同一事实源",
    "点击一条 Temporal Run",
    "等待 Worker 领取第一个节点",
    "版本化 RuleSet",
    "GovernanceService 判定",
    "技能（Skills）",
    "工具（Tools）",
    '"Serverless"',
    "{run.mode}</option>",
    "{nodeRun.sideEffectStatus}</Badge>",
    "· attempt {nodeRun.attempt}",
    'run.workflowVersion ?? "legacy"',
    "开发者视图 → Editor 编排画布",
    '"advanced-sla": "Advanced SLA"',
  ]) assert.equal(pageSource.includes(forbidden), false, forbidden);

  assert.ok(packSource.includes("name: 'Readywork 采购执行'"));
  assert.equal(packSource.includes("name: 'Readywork Procurement Execution'"), false);
});
