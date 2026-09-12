# Readywork 产品架构与交付顺序

> 本文固化 Readywork 从第一个垂直员工走向多员工平台的交付顺序。采购产品 V1 的完成条件仍以 [`PROCUREMENT-V1-SCOPE.md`](PROCUREMENT-V1-SCOPE.md) 为唯一口径。

## 1. 产品形态

Readywork 不是把每个业务步骤拆成一个平级“员工”，也不是先交付一个空白低代码平台。

```text
Readywork 通用运行时
├── Manufacturing Context / Twin
├── Temporal Durable Runtime
├── Agent Runtime
├── Action Gateway
├── Connector Runtime
└── Employee Pack 合同与注册表
          │
          ├── Navisight Procurement Employee Pack（第一个产品）
          ├── Finance Employee Pack（后续）
          ├── Sales Employee Pack（后续）
          └── Customer Service Employee Pack（后续）
```

一个 Employee Pack 声明岗位身份、业务界面、工作流、Workers、Skills、Tools、Context 实体、治理规则与连接器要求；租户凭据和业务记录不进入 Pack。不同 Pack 复用同一运行时、权限、审计、Context 与连接器基础设施。

## 2. 冻结交付顺序

### 阶段 A：Navisight 采购员工 V1

先完成真实的 `PO Sent → Supplier Commitment → Fulfilment / Production → Dispatch / Transit → Delivery / GRN`：

- 供应商可见具名采购身份；
- 正式发布的阶段 SLA；
- 有明确证据的本地采购路线；
- 邮件、Odoo、SQLite、SLA、通知、风险和审计引用同一张真实 PO；
- 部分发运、部分收货、最终 GRN、重启恢复和幂等均通过验收。

采购需求、RFQ、发票、Teams 和通用 Editor 可以继续存在，但不计入 Navisight V1 发布完成度。

### 阶段 B：通用 Governance

采购 V1 通过后，再把现有执行治理扩成跨 Pack 的 AI 行为治理：

- Northstars / 可机器检查的业务原则；
- 历史案例与回归测试集；
- 上线前 Eval、生产抽样 Audit、人工反馈；
- Workflow / Employee Pack 版本比较和渐进发布；
- 业务结果与失败案例自动沉淀为后续评测证据。

Governance 判断“AI 的判断是否正确”；Action Gateway 继续判断“即使想做，是否有权产生外部副作用”。两者不能合并。

### 阶段 C：App Builder

在 Context API、Workflow API 和 Governance 合同稳定后，提供可复用的应用构建层：

- Workflow Canvas 与 workflow-as-code；
- Trigger、Agent、Tool、Condition、Branch、Wait、Approval、Loop 节点；
- 业务 Workspace 模板、版本、测试、Replay 和部署；
- 应用只能通过已授权 Context 和 Action Gateway 访问业务事实与外部系统。

V1 的采购工作台仍是专业预制产品，不被降级为通用表单生成器。

### 阶段 D：多员工主管台

最后增加跨 Employee Pack 的主管视图：

- 员工状态、任务、异常、审批、预算和 KPI 聚合；
- 跨员工委派、升级、共享 Context 和责任边界；
- Pack 安装、版本、连接器依赖与租户部署状态；
- 主管台只聚合真实员工运行数据，不复制各垂直工作台的业务状态机。

## 3. 当前实现映射

| 架构能力 | 当前实现 |
| --- | --- |
| Employee Pack 合同与注册表 | `packages/core/src/employee-pack.ts` |
| 第一个采购 Pack | `packages/supply-chain/src/procurement-employee-pack.ts` |
| Pack 清单与员工绑定 API | `GET /api/employee-packs` |
| 业务导航和品牌读取 Pack | `apps/console/features/platform/employee-packs.ts` |
| Manufacturing Context / Twin | `packages/context`、`apps/api/src/manufacturing-context-*` |
| Durable Workflow | `packages/temporal-runtime`、`apps/temporal-worker` |
| Action Gateway | `apps/api/src/action-gateway.ts` |
| Connector Runtime | `packages/connector-runtime`、`apps/api/src/connector-control-plane.ts` |
| 采购 V1 范围与门槛 | `docs/PROCUREMENT-V1-SCOPE.md`、`docs/NAVISIGHT-V1-ALIGNMENT.md` |

## 4. 不变量

1. 不为截图、演示或完成百分比制造业务事实。
2. LLM 不直接持有 ERP、邮箱或 WMS 写权限；所有副作用经过 Action Gateway。
3. Twin 是权威业务事实的可重建上下文投影，不是第二套 ERP。
4. Employee Pack 不携带租户凭据、联系人身份、真实业务记录或未审策略。
5. 新员工优先复用通用合同；只有垂直领域事实、工作流和界面进入 Pack。
6. 采购 V1 未通过真实闭环前，不宣称平台或采购员工已正式上线。

## 5. 2026-08-31 产品路线确认

- 产品交付顺序正式固定为：先完成 Navisight 采购员工 V1 真实五阶段闭环，再交付通用 Governance、App Builder 和多员工主管台。
- Navisight 已是第一个可安装 Employee Pack；公开 `/product` 页使用“问题 → 早期信号 → 解决方案 → 五阶段 → 风险决策 → 客户价值”的桌面叙事骨架，不另建一套业务数据。
- V1 当前只验收桌面 Web；移动导航和移动布局按用户决定后置，不纳入本轮完成度。
