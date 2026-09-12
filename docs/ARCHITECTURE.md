# AI Workforce OS — 总体架构（V1 基线）

> 历史说明：本文中的 “V1” 指早期通用运行时架构基线，不是 Readywork 采购产品 V1。采购产品的唯一范围与上线验收口径见 [PROCUREMENT-V1-SCOPE.md](PROCUREMENT-V1-SCOPE.md)。

> 本文档固化为产品架构基线，后续任何模块设计不得与之冲突。
>
> 当前 P2 已在本基线之上加入多租户持久化、Editor/Graph Runtime、Temporal、Connector Runtime、Manufacturing Context / Twin、Employee Pack 与业务面/控制面拆分；以 `docs/architecture/p2-runtime.md` 为当前运行架构，产品交付顺序见 [`PLATFORM-ROADMAP.md`](PLATFORM-ROADMAP.md)。

## 1. 纵向执行链（固定层级）

```
AI Organization        Company / Department / Human Employee / AI Employee / Manager / Goal / KPI / Budget
        │
        ▼
AI Employee            Identity / Role / Job Description / Goals / KPI / Context / Memory / Permissions / Policies / Budget / Human Escalation
        │
        ▼
Systems of Workers     专业 Worker / 临时 Worker / Subagent / Worker Router / Worker Collaboration
        │
        ▼
Workflows              Trigger / Condition / Agent Step / Human Approval / Wait / Resume / Retry / Branch / Loop
        │
        ▼
Skills                 询价 / 催交 / 谈判 / 报价解析 / 合同分析 / 对账 / 催款 / 分类 / 行业 SOP
        │
        ▼
Tools                  Email / ERP / CRM / Browser / Excel / PDF / Database / API / MCP / Computer Use
        │
        ▼
Enterprise Systems     SAP / 用友 / 金蝶 / Salesforce / 企业微信 / 钉钉 / 飞书 / WMS / TMS / OA
```

**语义约定（不变量）：**

| 概念 | 含义 |
| --- | --- |
| Employee | 谁负责这份工作（有身份、权限、预算、KPI 的"岗位"） |
| Worker | 哪个专业执行单元来完成某类任务（被 Employee 装配） |
| Workflow | 这件事按什么业务流程推进（状态的真正所有者） |
| Skill | AI 会什么（确定性能力，可被 Agent 决策调用） |
| Tool | AI 如何碰现实世界（带权限与成本的原子操作） |

## 2. 横向贯穿四个核心系统

```
              Build Plane            Run Plane             Control Plane
              创建员工               运行员工               管理员工
              (Employee Spec)        (Task/Event Loop)      (Control Tower / Evals)
                    \                    |                    /
                     \                   |                   /
                      └──────────┬───────┴───────┬──────────┘
                                 ▼               ▼
                     ┌───────────────────────────────────┐
                     │        Business Runtime (微内核)   │
                     │  Task / State / Event / Wait /     │
                     │  Resume / Retry / Approval /       │
                     │  Permission / Policy / Budget /    │
                     │  Audit / Cost / Checkpoint         │
                     └───────────────────┬───────────────┘
                                         ▼
                     ┌───────────────────────────────────┐
                     │      Agent Runtime (DSH Adapter)  │
                     │  Model / Agent Loop / Session /   │
                     │  Context / Skills / Tools /       │
                     │  Subagents / Sandbox / Trajectory │
                     └───────────────────────────────────┘
```

### 2.1 边界原则（最重要的架构决策）

- **Harness 管 AI 怎么思考和行动** —— 我们不复造 Agent Loop / Subagent / Tool Calling / Session / Sandbox。
- **Business Runtime 管企业业务现在进行到哪一步** —— 这是我们的护城河，必须自己掌握：
  Task 状态机、Wait/Resume/Retry/Timeout/Checkpoint、审批与升级、权限与 Policy、预算与成本、审计与评测。
- 因此 `Business Runtime` **不直接依赖** Agent 实现：它只依赖一个端口（`AgentRuntimePort`），
  V1 用确定性 `InMemoryAgentAdapter` 跑通全链，之后换成 DeepSeek Harness 适配器，业务层零改动。

### 2.2 Context Plane —— 企业数字大脑

```
Enterprise Context Graph
  Company → Department / Human Employee / AI Employee
          → Customer / Supplier / Product / Material
          → Order / Contract / Invoice / Payment
          → Conversation / Document / Task / Decision / Policy
  每个实体保存: Entity + Relationship + Current State + History + Evidence + Memory
```

所有 AI Employee 按 `spec.contextScope`（权限）共享同一 Context Store；Agent 每次执行只拿到
权限范围内的 `ContextSnapshot`。

### 2.3 Control Plane —— 控制塔

管理员管理的是员工、任务、KPI，不是 Prompt：

- 员工视图：状态分布（Working / Waiting External / Waiting Approval / Idle / Failed）、按部门统计
- 单员工视图：Manager / KPI（回款率、人工介入率、任务成功率）/ 权限清单 / 本月任务统计
- 任务视图：按状态过滤、待审批队列、事件流审计

## 3. 插件体系与 Employee Pack

```
Plugin Runtime
  Employee / Worker / Workflow / Skill / Tool / Connector / Context / Model / Employee Pack

Employee Pack（可安装产品单元）  e.g. Navisight Procurement Employee Pack
  └─ 采购执行员工
      ├─ 采购需求 / 询价 / PO / 交付 / 应付等内部能力模块
      ├─ 版本化 Workflows / Workers / Skills / Tools
      ├─ 业务与开发者界面合同
      └─ Context / Governance / Connector 要求
```

**战略：底层通用，产品垂直。** Pack 只声明岗位产品资产与运行要求；租户凭据、联系人身份、真实业务事实和未审批策略不得进入 Pack，其余全部复用内核。

## 4. 模块 ↔ 仓库映射

| 框架层 | 仓库包 |
| --- | --- |
| Business Runtime 微内核 | `packages/core` |
| Agent Runtime Adapter | `packages/agent` |
| 流程层引擎 | `packages/workflow` |
| 能力层插件系统 | `packages/skills` |
| 工具层插件系统 | `packages/tools` |
| Context Graph | `packages/context` |
| Control Tower | `packages/control-tower` |
| Employee Pack 合同 | `packages/core/src/employee-pack.ts` |
| Employee Pack | `packages/supply-chain`（首个：Navisight 采购执行员工） |
| 运行入口 | `apps/demo`、`apps/api` |

依赖方向（严格单向，无环）：

```
core ← agent / skills / tools / context / workflow / control-tower
     ← supply-chain ← apps/demo, apps/api
```

## 5. V1 范围（不做的事同样重要）

V1 只实现：Employee Definition、Worker/Workflow Runtime、Task 的 Wait/Resume/Retry/Approval、
DSH Adapter 端口（桩实现）、Skill/Tool 插件系统、基础 Context、Control Tower、供应链 Pack。

V1 明确不做：真实 LLM 执行（用确定性桩）、持久化（内存存储）、真实企业连接器（SAP/金蝶等）、
多租户隔离、Web UI。详见 `docs/V1-DESIGN.md`。
