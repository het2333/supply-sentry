# 数据模型（当前实现与 V1 目标）

> 当前代码已经同时存在 legacy 内存/持久化任务模型、控制面 SQLite 模型和 Temporal Workflow/NodeRun 模型；不能再概括为“V1 全内存”。本文把已存在的通用模型与采购 V1 目标模型分开，目标中的未实现字段不表示当前已完成。

## 0. 实现现状（2026-08-21）

- `Task`、`BusinessObject`、审批、事件和组织数据在业务面可使用 SQLite 持久化；无数据库或演示工具时仍可能落入内存。
- Editor 的 `WorkflowVersion`、`WorkflowRun`、`NodeRun`、RuleSet、Credential、Connector Installation 和 Action Execution 属于控制面租户隔离 SQLite 模型；Temporal 保存工作流历史。
- `packages/core/src/procurement-model.ts` 已定义 Item、Supplier、Requisition、RFQ、Quote、Award、PO、Confirmation、Shipment、Receipt、Invoice、Match、Communication 及其行对象；`packages/persistence` 已用租户隔离的 SQLite 单据表/行表保存这些版本化对象。
- PO 行数量事件账本与投影已落地：按 `confirmed/shipped/received/invoiced/cancelled` 累计，支持幂等重放、冲销和异常派生；无 ASN 收货、发票先到或未确认先发运会保留事实，不会静默丢弃。
- 行级三单匹配已实现四类确定性结果与不可变决策快照：`exact_match`、`within_tolerance`、`approval_required`、`severe_exception`，支持部分收货/部分发票的历史累计分配。
- 采购执行 API 已覆盖 PO 发送/确认、发运/收货/发票登记、行级匹配与应付决策；外部邮件和 ERP 回写进入租户隔离的持久化 Outbox。只有连接器返回真实成功，Outbox 才在同一事务推进 PO 或发票事实；租约、幂等、重试与结果不确定时的人工对账均已落地。
- Temporal 审批信号已绑定当前等待节点、业务对象、决策、规则/快照和可信会话身份；持久化 decision claim 支持同结论安全重放，并只在 Temporal 审计确认已推进时收敛中断窗口。
- 协同/Teams 已具备租户与 AAD object ID 绑定、会话引用、签名 Adaptive Card、二次确认和 Bot Framework JWT/JWKS 校验；主动通知只有 OAuth 配置、已绑定会话且 Teams 返回 2xx 时才记为 sent。未配置 Bot、绑定或真实 Teams 凭据时明确 unavailable。
- 生产监控已聚合 Temporal worker/poller、Action/Outbox 租约、失败队列、连接器/凭据和安全告警；它报告真实就绪度，不会把未配置的外部服务标为健康。
- `packages/tools` 中 ERP RFQ、Excel 台账、部分收货能力仍有内存参考实现；Odoo PO 读取/ETA 更新、供应商主数据只读同步和企业邮箱只有在配置连接器后才是外部事实源。采购域仓储与 RFQ/结构化报价 API 已接入，但报价邮件归集、邮件发送、WMS/ERP 事件、ERP 授标和 Odoo AP 的完整连接器闭环仍未全部接入，不能把“模型已存在”宣称为“生产链已完成”。

## 1. 核心实体

### 组织与员工

| 实体 | 关键字段 |
| --- | --- |
| Tenant | id, name |
| Department | id, tenantId, name |
| HumanEmployee | id, tenantId, deptId, name, email, role, managerId? |
| AIEmployee | id, tenantId, deptId, specId, name, role, status, managerId?, stats, createdAt |
| EmployeeStats | tasksTotal, tasksCompleted, tasksFailed, humanTakeovers, onTimeCompleted, totalCost |
| EmployeeSpec | id, name, departmentId, version, role, goals[], workers[], workflows[], skills[], tools[], permissions[], policies[], approvalRules[], budget?, contextScope[], evalCriteria[], humanEscalation |

### 任务（Task 状态机）

```
Task {
  id, tenantId, employeeId, workflowId, businessObjectId,
  status, attempts, maxRetries, instruction?,
  checkpoint: { stepIndex, pendingApprovalId?, waitingReason?, workspace },
  createdAt, startedAt?, completedAt?, failedAt?, error?,
  metadata: { onTime?, result? }
}
```

### 业务对象 / 审批 / 预算 / 上下文

| 实体 | 关键字段 |
| --- | --- |
| BusinessObject | id, type, status, attributes, state, history[]（不可变审计）, updatedAt |
| ApprovalRequest | id, taskId, ruleId, title, message, payload, status(pending/approved/rejected), requestedAt, decidedAt?, decidedBy?, reason? |
| BudgetState | employeeId, monthlyCap, currency, month(YYYY-MM), spent |
| ContextEntity | id, type, attributes, state, updatedAt |
| Relationship | from, to, type, since |
| Evidence | id, at, entityId?, source, summary |
| ContextSnapshot | employeeId, at, entities[], relationships[], memory |

### 采购 V1 域对象（数据契约已落地，业务接入程度不同）

| 实体 | 最小字段与约束 | 当前状态 |
| --- | --- | --- |
| Requisition | id, tenantId, lines[], status, requestedBy, sourceSystem, externalId | 单据/行仓储、原子幂等创建、租户隔离 API 和非技术 UI 已接通 |
| Supplier | id, tenantId, sourceSystem, externalId, name, currency, contacts[], status | Odoo 现有供应商主数据只读同步已接入；`POST /api/procurement/suppliers/sync` 要求 `configure` 权限，按租户以 `supplier:odoo:{partnerId}` 幂等 upsert；不做准入、不写 ERP，Odoo 未配置返回 409 |
| RFQ | id, requisitionId, supplierIds[], status, ruleSetVersion, awardedSupplierId | 标准对象、通用单据/行仓储、RFQ/结构化 Quote API 与草稿 UI 已落地；邮件发送和 ERP 授标尚未接入 |
| Quote | id, rfqId, supplierId, lines[], currency, receivedAt, sourceEvidence | 标准对象、仓储、结构化报价 API 与确定性标准化/比价已落地；邮件附件自动归集和解析尚未接入 |
| PurchaseOrder / POLine | id, externalId, supplier, lines[], status, promiseDate, totals | 标准对象、仓储、行级投影和执行 API 已落地；发送/催交经持久化 Outbox 派发，只有真实连接器成功才推进状态。Odoo 读取/ETA 更新需已配置凭据 |
| Shipment / Receipt | id, poLineId, shippedQty, receivedQty, eventId, receivedAt | 标准对象、仓储和 PO 行累计规则已落地；签名 Connector webhook 可幂等登记确认、发运、收货、发票与取消事实。通用 WMS 适配仍需配置/接入 |
| Invoice | id, externalId, poId, lines[], amount, tax, status | 标准对象、仓储、执行 API 和应付 Outbox 已落地；Odoo 发票/收货行可读，三单/审批/待付白名单字段在真实连接器成功后才回写 |
| ThreeWayMatch | id, invoiceId, poLineId, result, variance, evidenceIds[], ruleSetVersion | 行级确定性计算、不可变决策快照、审批身份/对象/规则/快照绑定及审批后续跑已落地；真实 Temporal 服务与 ERP 凭据缺失时仍不可用 |
| Exception | id, objectId, type, severity, status, recommendation, approvalId | 控制塔已有异常查询、审批和转交能力 |

目标域对象必须以 `tenantId + externalId/sourceSystem` 做外部幂等边界，以 `POLine` 做数量和金额累计的最小粒度。上述目标模型与当前通用 `BusinessObject.attributes` 之间需要版本化迁移，不能把任意 attributes JSON 当作最终契约。

## 2. Task 状态机

```
状态: created, queued, running, waiting_external, waiting_approval, waiting_human,
      completed, failed, cancelled

迁移白名单:
  created            → queued | running | cancelled
  queued             → running | cancelled
  running            → waiting_external | waiting_approval | waiting_human | completed | failed | cancelled
  waiting_external   → running | cancelled
  waiting_approval   → running | failed | cancelled      // reject → failed(终态)
  waiting_human      → running | cancelled
completed / failed / cancelled → (终态)
```

说明：这是 legacy `WorkflowEngine` 的任务状态机。Temporal Editor 运行另有 `queued/running/waiting_approval/waiting_external/completed/failed/cancelled` 与 `NodeRun` 状态；两者通过兼容 API 展示，但不是同一张状态表。采购执行聚合/行、审批和 Outbox 已以版本化单据表关联；真实续跑仍取决于 Temporal 服务与 worker/poller 已配置并观测到运行。

## 3. 领域事件目录（EventBus，全部追加进 eventLog 供审计/控制塔）

| 事件 | 触发 | 负载要点 |
| --- | --- | --- |
| task.created | create | taskId, employeeId, workflowId |
| task.started | start | |
| task.waiting | wait | reason, untilAt?, forEvent? |
| task.resumed | resume | reason? |
| task.waiting_approval | requestApproval | approvalId, ruleId, title |
| task.approved / task.rejected | approve/reject | approvalId, by |
| task.completed | complete | result? |
| task.failed | fail(终态) | error, attempts |
| task.retrying | fail(可重试) | attempt, error |
| task.handed_off / handoff_finished | handoff 流程 | reason |
| task.cancelled | cancel | |
| employee.status_changed | 引擎同步 | from, to |
| tool.called | 工具执行 | tool, action, ok, cost |
| budget.recorded | 成本记账 | amount, currency |
| context.event | 业务事件注入 | eventType, objectId?, payload? |

业务恢复约定：`wait(forEvent)` 订阅 `context.event`，`eventType + objectId` 匹配即恢复。

## 4. 当前关系与目标关系

当前通用关系（已实现的骨架）：

```
Tenant 1─* Department 1─* HumanEmployee
                  └─────* AIEmployee *─1 EmployeeSpec(岗位定义)
AIEmployee 1─* Task *─1 WorkflowDef
Task 1─1 BusinessObject(po/rfq/requisition/…)
Task 1─* ApprovalRequest
AIEmployee 1─1 BudgetState
ContextEntity *─* ContextEntity(Relationship)
Task *─* Evidence(审计)
```

采购 V1 关系（单据/行持久化已落地；连接器和业务 API 仍按上表分阶段接入）：

```text
Tenant 1─* Requisition 1─* RequisitionLine
Requisition 0..1─1 RFQ 1─* Quote 1─* QuoteLine
RFQ 0..1─1 PurchaseOrder 1─* POLine
POLine 1─* Shipment 1─* Receipt
POLine 1─* InvoiceLine ─*─1 Invoice
Invoice + PurchaseOrder + Receipt ──▶ ThreeWayMatch(按行/汇总)
任何对象 ──* ApprovalRequest / Exception / Evidence / BusinessEvent
Task / WorkflowRun / NodeRun ──* BusinessActivity
PurchaseOrder / Invoice ──* ProcurementOutboxMessage ──▶ 已配置的 Email / ERP Connector
TeamsTenant + AADObjectId ──▶ HumanEmployee；其会话引用 ──▶ 签名 Adaptive Card
```

`Task` 是执行载体，不是采购单据本身；`WorkflowRun/NodeRun` 是 Temporal 图的运行轨迹，也不能替代 ERP 的 PO、收货或发票事实。当前 API 仍会将部分采购事实放在 `BusinessObject.attributes`，这是兼容层而非目标关系模型。

## 5. 时序示例：PO 运营主链（当前 legacy 验证链；外部写回需配置）

```
WorkflowEngine                 TaskMachine             Scheduler/EventBus        ERP/Email/Context
     │  runTask(po-operations)     │                          │                       │
     │ ──create──▶ created ──start──▶ running                  │                       │
     │ step0 tool erp.po.get        │                          │                   读取PO ✓(成本0.1)
     │ step1 skill 交期解析         │                          │                       │
     │ step2 agent 核对回复         │                          │                       │
     │ step3 wait(供应商确认,400ms)│ ──wait──▶ waiting_external│ 挂定时器+订阅事件      │
     │ 引擎挂起,员工 waiting_external                             │                       │
     │                             │                          │ ◀─ context.event: supplier_confirmed
     │ resume() ◀──────────────────┼───────────────────────────┘                       │
     │ step4 agent 提取回复 → step5 解析新交期 → step6 延期识别(11天)                      │
     │ step7 condition 11>7 → step8 approval(delay-over-7d)                            │
     │ ──requestApproval──▶ waiting_approval                                           │
     │ 人工 approve(task, approvalId, 采购经理) ──▶ running                            │
     │ step9 tool erp.po.update(交期)  ────────────────▶ 内存更新；配置 Odoo 后外部回写 │
     │ step10 agent 催交(skill+email) ─────────────────▶ 内存发件箱；配置 SMTP 后真实发信 │
     │ step11 wait(到货) ──▶ waiting_external                                           │
     │ ◀─ context.event: goods_received ── resume                                      │
     │ step12 tool erp.po.close ────────▶ 内存关闭；Odoo 状态机回写尚未完整支持         │
     │ step13 notify → step14 end ──complete──▶ completed  (stats+onTime 记账)          │
```
