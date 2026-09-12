# V1 设计文档

> 历史说明：本文记录早期 AI Workforce Runtime 的实现里程碑，不再定义 Readywork 采购产品 V1。采购产品的唯一范围与上线验收口径见 [PROCUREMENT-V1-SCOPE.md](PROCUREMENT-V1-SCOPE.md)。

## 1. V1 范围（8 项）

1. Employee Definition（Employee Spec：角色/目标/KPI/权限/Policy/审批规则/预算/上下文范围/评测标准）
2. Worker / Workflow Runtime（WorkerRegistry + WorkflowEngine 逐步执行）
3. Business Task：Wait / Resume / Retry / Approval（核心状态机 + 事件/定时恢复）
4. DeepSeek Harness Adapter（`AgentRuntimePort` 端口 + InMemory 桩 + DSH 占位实现）
5. Skill / Tool 插件系统（Registry + 内存参考实现）
6. 基础 Context（Entity / Relationship / Evidence / Memory + 权限快照）
7. Control Tower（员工/任务/审批/事件查询 + KPI 计算）
8. 供应链 Workforce Pack（采购需求员工 / 询价员工 / PO 供应商运营员工）

## 2. 技术选型

- TypeScript + pnpm monorepo（与 DeepSeek Harness 同构：`@deepseek-ai/dsh-root`，pnpm 11.7 / Node ≥22）
- **零运行时依赖**：状态机、事件、调度、HTTP API（`node:http`）全部标准库；仅 devDeps：typescript、tsx、@types/node
- 存储：V1 全内存（Map），接口层已留持久化替换点
- 执行：Node 26 原生 TS + tsx 直接运行源码，`tsc --noEmit` 做全仓类型检查

## 3. 包结构与依赖

```
packages/core        —— 微内核（无内部依赖）
packages/agent       —— AgentRuntimePort + InMemoryAgentAdapter + DeepSeekHarnessAdapter(占位)  → core
packages/workflow    —— WorkflowDef/WorkflowStep/WorkflowEngine                              → core, skills, tools
packages/skills      —— SkillRegistry                                                        → core
packages/tools       —— ToolRegistry + ErpTool/EmailTool/PdfTool/ExcelTool(内存参考)          → core
packages/context     —— InMemoryContextStore                                                 → core
packages/control-tower —— TowerService                                                       → core, workflow
packages/supply-chain —— 3 Specs + 3 Workflows + 5 Skills + 4 Tools + Agent Handlers         → 全部
apps/demo, apps/api  —— 验证链演示 / HTTP API                                               → supply-chain
```

## 4. 核心设计

### 4.1 Task 状态机（微内核的心脏）

```
            created ──start──▶ running ──complete──▶ completed
               ▲                │  ▲
          cancel│          fail│  │retry(attempts≤max)
               │                ▼  │
            cancelled         failed(终态,重试耗尽/审批拒绝)
```

- `running` → `waiting_external`（wait：等事件或定时器）→ `resume` → `running`
- `running` → `waiting_approval`（requestApproval）→ `approve/reject` → `running / failed`
- `running` → `waiting_human`（handoff 人工接管）→ `finishHandoff` → `running`
- 非法迁移直接抛错（`TRANSITIONS` 白名单表）
- 每次 `wait` 都会持久化 `checkpoint`（步骤索引 + workspace），天然支持崩溃恢复（V2 落盘即得）

**恢复语义**：`wait` 可挂 `untilMs`（调度器定时恢复）与/或 `forEvent`（事件选择器恢复）；
引擎对同一任务只恢复一次（幂等）。

**重试语义**：`fail` 时若 `attempts ≤ maxRetries` 则回到 `running` 并重新执行同一 step（checkpoint
不回退），否则进入终态 `failed`。

### 4.2 Agent 执行模型（关键决策）

```
Workflow 决定流程（agent/tool/skill/wait/approval/condition/notify/end 步骤）
Agent 决定行动（返回 actions: tool 调用 / skill 调用 + stateUpdates）
Runtime 执行行动（权限校验 → 工具执行 → 成本记账 → 事件审计）
```

- Agent 步骤收到的是**权限范围内的 ContextSnapshot**，不是整个数据库
- 所有 tool 动作过 `PolicyEngine.can()`（默认拒绝，白名单 + 显式 deny）
- 所有 tool 调用记录成本（BudgetService）与事件（tool.called）
- 工具参数支持 `{{workspace.x.y}}` / `{{bo.attributes.z}}` 模板插值，Agent 输出可被后续步骤引用

### 4.3 权限与 Policy

- `PermissionRule { effect: allow|deny, action, resource }`：`po.*` 通配，deny 优先，无 allow 即拒绝
- `PolicyRule { when, then: block|require_approval }`：运行时策略（如"价格锁定"）
- `ApprovalRule`：工作流中显式挂审批步骤；Spec 中的规则是元数据（供控制塔展示与 V2 自动审批引擎）

### 4.4 Context

- `ContextEntity { id, type, attributes, state }` + `Relationship` + `Evidence` + 员工私有 `Memory`
- `snapshotFor(employeeId, scope)` 按 `spec.contextScope` 过滤后快照，快照为纯 JSON（可直接进 LLM 上下文）

## 5. 验证链（`pnpm demo`）

> 创建员工 → 给权限 → 给业务任务 → AI执行 → 等待 → 恢复 → 调工具 → 人工审批 → 完成 → 评测

| # | 环节 | 演示内容 |
| --- | --- | --- |
| ① | 创建员工 | 3 张 Spec 实例化为 AIEmployee（含目标/KPI/权限/预算） |
| ② | 给权限 | `po.get` 允许、`po.updatePrice` 拒绝（含 Policy 触发演示） |
| ③ | 业务任务 | 采购需求 60 万 → 自动分类 → 大额审批 |
| ④ | AI 执行 | 询价单创建 → 邮件发送 → 等待报价 |
| ⑤ | 等待 | `waiting_external`（任务挂起，员工状态同步） |
| ⑥ | 恢复 | 供应商邮件事件 → 引擎自动恢复 → 报价解析 → 比价推荐 |
| ⑦ | 调工具 | 中标审批通过后 ERP 落单 |
| ⑧ | 人工审批 | 延期 11 天 > 7 天 → `waiting_approval` → 采购经理批准 → 更新交期 + 催交邮件 |
| ⑨ | 完成 | 到货事件 → PO 关闭 → `completed` |
| ⑩ | 评测 | KPI（成功率/人工介入率/准时率/成本）+ 控制塔总览 |

## 6. DeepSeek Harness Adapter（V1.5 已实现 ✅）

`packages/agent` 已实现并跑通验证链：

- `HarnessRuntime` —— 自实现 DSH SDK 协议客户端（newline JSON-RPC over stdio，与官方
  `@deepseek-ai/dsh-sdk-client` 同一 wire 契约）：spawn runtime → initialize 握手 →
  session/prompt → 收集 session.event 至 session.status idle → 提取 finalResponse
- `DeepSeekHarnessAdapter` —— `AgentRuntimePort` 真实实现：AgentRequest → 系统提示
  （员工身份 + 权限内上下文快照 + 工具/技能清单 + JSON 输出契约）→ 一次 agent 回合 →
  决策 JSON 解析为 AgentResult；工具/技能执行、权限、记账仍由 WorkflowEngine 负责
- **无 key 验证**：`pnpm demo:dsh` 自动起 `apps/mock-model`（OpenAI 兼容 SSE 端点，脚本化
  决策），DSH runtime 完整真实运行，仅模型调用打到 mock；业务层与 `pnpm demo` 共用
  `apps/validation` 验证链，零改动

**对接映射（已落地）**：

| 我们的概念 | DSH 侧 |
| --- | --- |
| AgentRequest.contextSnapshot | 系统提示中的 `[上下文快照]` 段（纯 JSON） |
| toolDescriptors / skillDescriptors | `[可用工具]` / `[可用技能]` 段（V1.6 升级为 MCP 注册） |
| AgentResult.actions | 模型输出的 JSON 决策（`[输出契约]` 约束格式） |
| 长期任务 wait 挂起 | 每次执行独立 session，不占用 DSH 资源 |
| subagent 派生 | V1.6：对接 DSH Subagent（协议已支持 subagent.started/finished） |

**接入真实模型**：设置 `DEEPSEEK_API_KEY`（可选 `DEEPSEEK_BASE_URL`）后运行 `pnpm demo:dsh`
即直连真实服务；runtime 由 `examples/jsonrpc-agent/cordis.yml` 组合（llm-deepseek provider、
sandbox、session 持久化等）。

**生产化待办**：runtime 二进制打包（当前经 `node --import tsx` 启动）、MCP 工具桥、
多 worker 并发 session 池、trajectory 回传 Evals。

## 7. HTTP API（`pnpm api` → :4173）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /health | 探活 |
| GET | /api/tower/overview | 控制塔总览 |
| GET | /api/tower/employees | 员工列表 |
| GET | /api/tower/employees/:id | 员工详情 + KPI |
| GET | /api/tasks?status= | 任务列表 |
| GET | /api/approvals/pending | 待审批队列 |
| POST | /api/tasks/:id/approve | 审批通过 `{approvalId, by}` |
| POST | /api/tasks/:id/resume | 恢复任务 |
| POST | /api/events | 注入业务事件（模拟供应商/到货） |

## 8. 后续迭代清单

- [x] DSH 真实 Adapter（见第 6 节）
- [x] 持久化（node:sqlite：Task/BusinessObject/Approval/Event/Org/Budget 落盘 + Checkpoint/重启恢复，`packages/persistence`，`pnpm demo:persist`）
- [x] MCP 工具桥（`apps/mcp-bridge`：ToolRegistry/SkillRegistry 暴露为 DSH Tool，agent 原生 tool-calling，`pnpm demo:mcp`）
- [x] Evaluations 工具链（`packages/evals`：轨迹录制/评分/回归对比，`pnpm eval`）
- [x] Web Control Tower（`apps/web`：node:http 零依赖仪表盘，`pnpm web`）
- [x] 员工优先控制台（`apps/console`：Next.js + Tailwind，接入真实后端，`pnpm api` + `pnpm console`）
- [ ] 连接器插件：SAP/金蝶/用友/企业微信/钉钉/飞书（Connector Plugin 端口）
- [ ] 自动审批引擎（按 ApprovalRule 路由到 Manager 或 AI 复审）
- [ ] 多租户隔离与鉴权
- [ ] 更多 Workforce Pack（Finance / Sales / Customer Service / HR）
