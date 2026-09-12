# Manufacturing Context / Twin 设计规格

**状态：** 已于 2026-08-29 经用户书面确认  
**日期：** 2026-08-29  
**范围：** Readywork V1 的 Manufacturing Context / Twin 第一阶段  
**后续顺序：** Context/Twin 完成并验收后，再分别设计 Eval/Governance 与 Workspace/App

## 1. 目标

在不替换现有采购事实层、不削弱 Temporal 和 Action Gateway 的前提下，为 Readywork 增加一个可持久化、可追溯、可重放的制造业上下文层。

该层必须让 Agent、工作流和 Web 工作台共享同一份上下文，并能够回答：

- 当前 PO、供应商、物料、询价、报价、定标、邮件、发运和收货之间是什么关系；
- 每一个业务事实来自哪里、何时观察到、可信度与优先级是什么；
- Agent 看过什么、提取了什么、判断了什么、建议或请求执行了什么；
- 某次 Agent 运行使用的是哪一个不可变上下文快照；
- 当前缺少哪些真实事实，哪些值互相冲突，哪些是人工纠正；
- 投影失败、重试、死信和重放是否影响过业务事实。

Twin 是现有业务事实的增量投影与上下文索引，不是第二套 ERP，也不是新的采购状态机。

## 2. 已有基线

### 2.1 保留不动的执行内核

以下组件继续作为 Readywork 的正式执行内核：

- Business API 与 Control API；
- SQLite 采购事实层；
- Temporal Durable Execution；
- DeepSeek Harness / Agent Runtime；
- Action Gateway；
- Connector Runtime、Outbox、Odoo、SMTP/IMAP、ClamAV；
- 现有审批、权限、SLA、安全事件和审计表。

### 2.2 当前 Context 与 Eval 的实际状态

- `packages/context` 目前只有 `InMemoryContextStore`，不能跨进程共享，也不能在重启后恢复。
- `packages/core/src/context-types.ts` 只有通用实体、关系、证据和内存快照契约，没有租户、来源版本、事实优先级、冲突、不可变快照和投影队列语义。
- `packages/evals` 目前是早期运行时回放评分，不属于本阶段实现范围。
- 正式采购事实已经持久化在 `procurement_documents`、`procurement_lines`、`procurement_po_stage_events`、`procurement_outbox`、`runtime_*` 等表中。

### 2.3 首个真实验收对象

首个验收对象固定为：

```text
po:7c4c2aa5-b119-4e14-8953-a9fc78882e2a
```

截至规格编写时，可验证事实为：

- 供应商：`上海卓越阀门`，来源为本地 Odoo 供应商主数据；
- 物料：`气动阀 PV-30，按制造规格验收`；
- 数量：`200 件`；
- 单价：`127 CNY`；
- PO 状态：`sent`；
- Outbox：`purchase_order.send` 已真实进入 `dispatched`；
- 当前阶段：`supplier_commitment`；
- 阶段证据只有迁移生成的 `observed_status_backfill`，不是精确业务迁移时间；
- Odoo 采购订单尚未创建；
- 尚无与该 PO 关联的供应商正式确认；
- 尚无生产、发运、部分收货或最终 GRN 事实。

任何 Twin 页面、快照或 Agent 输出都必须保留这些缺口，禁止把上游同一供应商的其他邮件或其他 Odoo PO 错配到该 PO。

## 3. 设计原则

### 3.1 单一事实权威

采购事实仍由现有表与外部系统回执负责。Twin 只保存：

- 规范化实体与关系；
- 对原始事实的证据引用；
- Agent 产生的数据；
- 不可变上下文快照；
- 投影运行状态。

Twin 投影失败不得回滚已经成功的 PO、邮件、Odoo、收货或审批事务，也不得改变这些事务的最终结果。

### 3.2 事实优先级

冲突解析采用固定优先级，优先级与模型置信度分开计算：

```text
400  Odoo / Email / WMS 等原始外部回执
300  已审批的人工纠正
200  确定性解析或规则计算
100  LLM 提取或推断
```

规则如下：

- 高优先级事实覆盖低优先级事实的当前投影视图，但低优先级证据不得删除；
- 同优先级时，先比较来源版本，再比较 `effective_at`、`observed_at` 和稳定证据 ID；
- `confidence` 只表示提取可信度，不能让 LLM 事实越级覆盖 ERP 或原始邮件；
- 人工纠正主要用于补缺或标记争议，不能静默改写已验证的外部回执；若外部系统本身错误，应先在权威系统中修正并重新同步；
- 历史快照永不因后续冲突解析而变化。

### 3.3 真实与推断分离

所有事实必须标记以下一种来源语义：

- `verified_external`：外部系统或渠道的原始回执；
- `approved_human`：绑定已批准审批的人工纠正；
- `deterministic`：确定性解析或规则计算；
- `model_derived`：LLM 提取、分类或推断；
- `observed_backfill`：迁移或回填观察到的历史状态，不能冒充精确事件时间。

界面和 Agent 快照必须同时返回来源语义，不能只返回最终值。

## 4. 范围与非范围

### 4.1 本阶段范围

- SQLite 持久化 Twin 数据模型；
- PO 主链的实体、关系、证据和 Agent 事件投影；
- 业务事务内创建幂等投影任务；
- 独立 projector 的租约、重试、死信和重放；
- 不可变 Agent 上下文快照；
- 租户隔离、字段脱敏和权限裁剪；
- Context 查询 API 与运维 API；
- PO 详情中的“制造上下文”页签；
- 对指定真实 PO 的只读回填、查询和验收。

### 4.2 本阶段不做

- 不把 SQLite 迁移到 PostgreSQL；
- 不引入图数据库；
- 不引入向量数据库或新知识库；
- 不替换现有 `procurement_documents` 或采购状态机；
- 不重新实现 Temporal、Action Gateway、Connector Runtime；
- 不实现完整 Eval/Governance；
- 不实现通用 App Builder；
- 不补 Voice、SMS 或其他新渠道；
- 不用模型生成供应商确认、生产进度、ASN、收货或 GRN；
- 不把其他 PO、其他邮件或截图演示数据写入当前 PO 的 Twin。

## 5. 组件边界

```text
采购业务事务 / 外部回执
          │
          ├─ 写入权威业务表
          └─ 同事务写 twin_projection_jobs
                         │
                         ▼
                 Twin Projector Worker
                         │
          ┌──────────────┼────────────────┐
          ▼              ▼                ▼
    twin_entities  twin_relations   twin_evidence
                         │
                         ├────────── twin_agent_events
                         └────────── twin_snapshots
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
             Agent / Temporal                       Web 工作台
```

组件职责：

- **业务仓储：** 只负责权威事实和投影任务的原子写入；
- **Twin Projector：** 读取投影任务，规范化实体、关系和证据；
- **Manufacturing Context Store：** 提供租户化查询、快照和 Agent 事件接口；
- **Snapshot Builder：** 按员工范围和字段权限生成不可变 JSON；
- **Context API：** 向 Web 和受控内部运行时提供查询；
- **PO Context UI：** 展示关系、证据、缺失事实、冲突、Agent 记录和快照水位；不直接修改权威事实。

现有 `InMemoryContextStore` 保留给旧演示和单元测试；正式采购链新增 SQLite 实现，不在本阶段删除旧接口。

## 6. 数据模型

所有表都必须包含 `tenant_id`，所有主键和唯一约束都以租户为第一维度。

### 6.1 `twin_entities`

保存规范化实体的当前投影视图。

| 字段 | 语义 |
| --- | --- |
| `tenant_id` | 租户 |
| `id` | 稳定 Twin 实体 ID |
| `entity_type` | `supplier`、`contact`、`material`、`rfq`、`quote`、`award`、`purchase_order`、`po_line`、`communication`、`shipment`、`receipt`、`invoice` 等 |
| `canonical_key` | 当前租户内的稳定业务键 |
| `label` | 可读标题 |
| `lifecycle_state` | 实体当前生命周期状态 |
| `attributes_json` | 当前规范化属性 |
| `state_json` | 当前运营状态与缺失事实摘要 |
| `current_revision` | 单调递增投影版本 |
| `source_watermark` | 生成当前投影的来源水位 |
| `effective_at` | 当前事实业务生效时间 |
| `observed_at` | 系统观察时间 |
| `created_at` / `updated_at` | Twin 记录时间 |

唯一约束：`(tenant_id, entity_type, canonical_key)`。

`source_watermark` 使用参与当前视图的 `(source_table, source_key, source_revision, source_hash)` 排序后做 SHA-256；相同来源集合必须得到相同水位。

稳定 ID 计算：

```text
twin:<entity_type>:<sha256(tenant_id + NUL + entity_type + NUL + canonical_key) 前 32 个十六进制字符>
```

V1 的 `canonical_key` 优先使用权威 `source_system:external_id`；Readywork 自建对象使用 `readywork:<business_object_id>`。

### 6.2 `twin_relations`

保存带证据的有向关系。

| 字段 | 语义 |
| --- | --- |
| `tenant_id` / `id` | 租户与关系 ID |
| `relation_type` | 例如 `ordered_from`、`contains_line`、`for_material`、`created_from_award`、`selected_quote`、`about`、`fulfilled_by`、`received_as` |
| `from_entity_id` / `to_entity_id` | 两端实体 |
| `status` | `active`、`superseded`、`disputed` |
| `source_evidence_id` | 支撑关系的证据 |
| `valid_from` / `valid_to` | 业务有效期 |
| `created_at` / `updated_at` | Twin 记录时间 |

关系只能连接同一租户实体。唯一约束由 `(tenant_id, relation_type, from_entity_id, to_entity_id, source_evidence_id)` 组成。

### 6.3 `twin_evidence`

保存不可变事实证据与冲突链。

| 字段 | 语义 |
| --- | --- |
| `tenant_id` / `id` | 租户与证据 ID |
| `entity_id` / `relation_id` | 证据作用目标，至少有一个 |
| `source_semantics` | `verified_external`、`approved_human`、`deterministic`、`model_derived`、`observed_backfill` |
| `source_kind` / `source_id` / `source_version` | 来源系统、来源对象与版本 |
| `source_hash` | 规范化来源内容哈希 |
| `fact_path` | 例如 `purchase_order.status`、`po_line.ordered_qty` |
| `value_json` | 该证据支持的值；不复制密钥或完整敏感原文 |
| `priority` | 100、200、300 或 400 |
| `confidence` | 0 到 1；确定性来源可为 1 |
| `effective_at` / `observed_at` | 生效与观察时间 |
| `actor_id` | 系统、员工或人工身份 |
| `raw_reference_json` | 指向现有业务表、附件或审计记录的引用 |
| `supersedes_evidence_id` | 显式替代链，可为空 |
| `created_at` | 不可变创建时间 |

该表只追加、不更新、不删除。相同来源、事实路径和来源哈希必须幂等。

### 6.4 `twin_agent_events`

保存 Agent 运行产生的不可变运营数据。

事件类型固定为：

```text
context_read
extraction
decision
recommendation
action_requested
action_result
human_feedback
business_outcome
```

主要字段包括：租户、事件 ID、员工 ID、Temporal Workflow ID、运行 ID、任务 ID、业务对象与 Twin 实体、事件类型、输入快照 ID、模型与推理配置、提示/响应哈希、工具或动作名、状态、置信度、证据 ID 列表、已脱敏 payload、创建时间。

约束：

- 不保存模型密钥、认证头、Cookie、Connector Credential；
- 默认不复制完整邮件正文和附件字节，只保存现有对象引用与内容哈希；
- `action_result` 只能引用 Action Gateway / Connector 的真实回执；
- LLM 的陈述不能自动变成 `verified_external` 证据。

### 6.5 `twin_snapshots`

保存 Agent 实际消费的不可变上下文。

| 字段 | 语义 |
| --- | --- |
| `tenant_id` / `id` | 租户与快照 ID |
| `employee_id` | 使用上下文的 AI 员工 |
| `root_entity_id` | 根实体 |
| `purpose` | 例如 `po_supplier_commitment` |
| `schema_version` | V1 固定为 `manufacturing-context/v1` |
| `source_watermark` | 来源事实水位 |
| `permission_fingerprint` | 员工范围与字段权限哈希 |
| `snapshot_json` | 已裁剪、已脱敏、纯 JSON 的完整快照 |
| `content_hash` | 规范化快照哈希，不包含快照 ID、`created_at` 等易变元数据 |
| `created_at` | 创建时间 |

快照一经创建不得更新。后续读取必须直接返回保存的 JSON，禁止依据当前事实重新计算旧快照。

V1 限制：单个快照最大 512 KiB、关系深度最大 2、实体最多 500、证据最多 2,000。超过限制时必须返回明确截断信息和游标，不能静默丢失。

### 6.6 `twin_projection_jobs`

保存业务事实到 Twin 的持久化投影任务。

| 字段 | 语义 |
| --- | --- |
| `tenant_id` / `id` | 租户与任务 ID |
| `source_table` / `source_key` / `source_revision` | 权威来源位置 |
| `event_type` | 投影事件类型 |
| `payload_hash` | 任务内容哈希 |
| `status` | `queued`、`processing`、`retry_wait`、`succeeded`、`dead_letter` |
| `attempts` / `max_attempts` | 尝试次数；V1 最大 8 次 |
| `available_at` | 下次可执行时间 |
| `lease_owner` / `lease_token` / `lease_expires_at` | 崩溃恢复租约 |
| `projected_watermark` | 成功后生成的水位 |
| `last_error` | 已脱敏错误摘要 |
| `created_at` / `updated_at` / `completed_at` | 生命周期时间 |

唯一约束：`(tenant_id, source_table, source_key, source_revision, event_type)`。相同唯一键再次入队时，若 `payload_hash` 不同，必须拒绝写入并记录数据完整性安全事件，不能把同一来源修订解释成两份事实。

## 7. 投影写入与恢复

### 7.1 原子入队

会改变 PO 上下文的业务事务必须在同一 SQLite 事务中：

1. 写权威业务事实；
2. 写对应的 `twin_projection_jobs`；
3. 提交业务事务。

首阶段覆盖：

- PO Draft 创建与真实发送回执；
- Odoo 同步与 Odoo 写回结果；
- 供应商入站确认及其差异审批；
- 经人工核验的生产/备货进度；
- 发运、运输节点、部分收货、最终 GRN；
- Outbox 状态变化；
- SLA 评估与升级；
- 与 PO 关联的邮件、附件和 Action Gateway 结果。

### 7.2 Projector 语义

- worker 使用 `BEGIN IMMEDIATE` 领取租约；
- 同一个来源修订重复投影必须得到相同实体、关系和证据，不增加重复记录；
- 第 1 至第 7 次失败后依次等待 5 秒、30 秒、2 分钟、10 分钟、30 分钟、1 小时、4 小时；
- 第 8 次失败进入 `dead_letter`；
- worker 崩溃后，租约过期任务可被其他 worker 重新领取；
- `last_error` 必须经过现有敏感信息清理；
- 投影成功只更新 Twin 与任务状态，不回写或改动采购事实。

### 7.3 回填

迁移后对现有 PO 主链创建幂等回填任务。

- 回填只表达当前观察到的事实；
- 历史状态若没有精确事件，只能写 `observed_backfill`；
- 回填不得制造供应商确认、发运、收货或 GRN；
- 重复执行回填后，实体、关系、证据和快照查询结果必须保持幂等。

### 7.4 死信重放

只有 `configure` 或 `admin` 身份可以重放死信。重放会：

1. 追加一条不可变运维审计事件；
2. 清除租约；
3. 将状态改为 `queued`；
4. 保留历史尝试次数和最后错误；
5. 使用相同幂等键重新处理。

重放不得删除旧证据，也不得修改业务表。

## 8. 查询与快照契约

### 8.1 Web 查询 API

```text
GET /api/context/v1/entities/:entityId
GET /api/context/v1/entities/:entityId/neighborhood?depth=1&include=evidence,agent_events
GET /api/context/v1/objects/:businessObjectId
GET /api/context/v1/snapshots/:snapshotId
GET /api/context/v1/projections/status
```

- 所有 API 都从当前 Session 取得租户，禁止接受客户端传入 `tenant_id`；
- 跨租户对象统一返回 404；
- 列表使用稳定游标，不使用无界全表返回；
- `objects/:businessObjectId` 负责把现有 PO ID 映射为 Twin 根实体；
- 响应必须包含 `sourceWatermark`、`projectionStatus`、`missingFacts`、`conflicts` 和 `truncated`；
- Web 查询不会创建快照，也不会执行外部副作用。

### 8.2 内部运行时 API / Port

Agent 与 Temporal 通过内部 Port 使用：

```text
getEntity(tenantId, entityId)
getNeighborhood(tenantId, rootEntityId, options)
createSnapshot(tenantId, employeeId, rootEntityId, purpose, scope)
getSnapshot(tenantId, snapshotId)
appendAgentEvent(event)
enqueueProjection(job)
```

创建快照只能由签名内部请求或同进程运行时调用。每一次 Agent 判断、建议或动作请求都必须引用 `input_snapshot_id`。

### 8.3 快照内容

V1 快照至少包括：

- 根实体与一至两层关系实体；
- 当前值及其最高优先级证据；
- 被覆盖但仍相关的冲突证据；
- 当前 PO 五阶段与精确度；
- 关联 SLA、异常、审批和 Outbox 状态；
- 员工可见的最近 Agent 事件；
- 明确的 `missingFacts`；
- 权限裁剪和截断说明。

## 9. 权限、租户隔离与脱敏

### 9.1 租户隔离

- 所有仓储方法都必须接收或绑定租户；
- 每条 SQL 必须以 `tenant_id = ?` 过滤；
- 关系创建前必须验证两端实体属于同一租户；
- 快照中的所有实体、关系、证据和 Agent 事件必须属于同一租户；
- 测试必须证明使用其他租户的 ID 无法读取、关联、重放或推断其存在。

### 9.2 权限

V1 复用现有 `read`、`operate`、`approve`、`configure`、`admin` 权限，并叠加 AI Employee 的 `contextScope`：

- `read`：读取普通运营字段和已脱敏联系人；
- `operate`：读取完成采购动作所需的供应商联系信息；
- `approve`：读取差异、价格、审批证据和人工纠正上下文；
- `configure` / `admin`：查看投影健康、重放死信、管理纠正规则；
- Agent：只能读取员工规格声明的实体类型、关系和字段。

### 9.3 字段分级

| 等级 | 例子 | 规则 |
| --- | --- | --- |
| 运营公开 | PO 号、状态、物料、数量、阶段 | `read` 可见 |
| 商业敏感 | 价格、付款条件、供应商评分、合同条件 | 按角色和员工范围裁剪 |
| 联系信息 | 邮箱、电话、联系人 | `operate` 以上或员工通信范围可见，否则遮罩 |
| 密钥 | 密码、Token、Cookie、认证头、Connector Credential | 永不进入 Twin 或快照 |
| 原始内容 | 邮件正文、附件字节 | Twin 只存引用与哈希；通过现有受控接口读取 |

现有 `redactSensitiveValue` 继续作为最低防线，但 Twin 必须增加字段级策略，不能只靠字段名正则。

## 10. 人工纠正与冲突

人工纠正不能直接修改 `twin_entities`。

流程为：

1. 用户提交纠正建议和证据引用；
2. 系统创建绑定实体、事实路径、旧值、新值和原因的审批；
3. 具有 `approve` 权限的另一身份批准；
4. 追加 `approved_human` 证据并创建投影任务；
5. projector 重算当前视图；
6. 追加 `human_feedback` Agent Event 和现有审计记录。

若新值与优先级 400 的外部事实冲突，Twin 将其显示为争议，不静默覆盖外部事实。

## 11. PO 工作台中的 Manufacturing Context

现有采购订单详情新增“制造上下文”页签，保持当前 PO 运营工作台的视觉骨架。

页面只使用真实 Context API，包含：

1. **实体摘要：** PO、供应商、物料、当前阶段、来源水位；
2. **关系列表：** 上游需求/RFQ/报价/定标、PO 行、供应商、通信、交付与发票关系；
3. **事实与证据：** 当前值、来源、优先级、置信度、观察时间和原始对象链接；
4. **缺失事实：** 例如“尚无供应商正式确认”“尚无 Odoo PO”“尚无 GRN”；
5. **冲突与纠正：** 被覆盖或争议的证据，以及需要审批的纠正入口；
6. **Agent 记录：** 使用的快照、判断、建议、动作请求与真实结果；
7. **投影状态：** 最新水位、是否滞后、是否存在死信。

V1 使用可扫描的分组列表和证据卡，不引入大型图可视化库。关系图属于 Workspace/App 阶段的可选增强。

## 12. 可观测性

`GET /api/context/v1/projections/status` 至少返回：

- queued、processing、retry_wait、dead_letter 数量；
- 最老待处理任务年龄；
- 最近成功水位与时间；
- 最近失败的已脱敏错误；
- worker 心跳与租约状态；
- 当前租户的实体、关系、证据、Agent Event 和快照数量。

门禁规则：

- 任一 `dead_letter` 存在时，Context 状态为 `degraded`；
- 最老任务超过 10 分钟时为 `degraded`；
- worker 无心跳超过 2 个轮询周期时为 `unavailable`；
- Context 降级不能伪装采购事务失败，但必须在运维和 PO 上下文页面显示数据可能滞后。

## 13. 测试策略

### 13.1 单元与仓储测试

- 新迁移可从空库和现有 v34 库升级；
- 所有表、索引和唯一约束正确；
- 租户隔离与跨租户 404；
- 证据不可变；
- 优先级、同级排序、冲突与人工纠正规则；
- 实体 ID 和水位稳定；
- 快照创建后不可变；
- 敏感字段与原始内容不进入快照。

### 13.2 Projector 测试

- 先写失败测试，再实现每一种投影；
- 重复任务幂等；
- 租约过期可恢复；
- 8 次失败进入死信；
- 重放保留审计并不重复证据；
- 投影失败不回滚权威业务事实；
- 回填只生成 `observed_backfill`，不生成精确历史事件。

### 13.3 API 与 UI 测试

- 未登录 401、无权限 403、跨租户 404；
- API 响应包含水位、缺失事实和投影状态；
- PO 页面加载、空态、错误态、滞后态和真实数据态；
- 刷新后上下文仍存在；
- UI 不显示密钥、完整认证信息或未经授权的联系信息；
- 页面不会把 LLM 推断标成 ERP/邮件事实。

### 13.4 真实 PO 验收

对 `po:7c4c2aa5-b119-4e14-8953-a9fc78882e2a` 执行正式回填后必须验证：

- 存在 PO、PO 行、供应商、物料、上游 Award/Quote/RFQ 可追溯实体与关系；
- PO 状态为 `sent`，供应商为上海卓越阀门，数量为 200，单价为 127 CNY；
- `purchase_order.send` Outbox 的 `dispatched` 是可追溯的真实证据；
- 阶段为 `supplier_commitment`，但迁移阶段事件明确标成 `observed_backfill`；
- `missingFacts` 明确包含 Odoo PO、供应商确认、生产、发运和 GRN；
- 不关联其他 PO 的邮件、Odoo 单据、发票、生产或收货；
- 对同一来源重放两次后，实体、关系、证据计数不增长，当前快照哈希稳定；
- 一个在后续真实运行中创建的 Agent 快照可以被 Agent Event 和审计记录共同引用。

只有后续真实邮件、Odoo、WMS/人工核验证据到达后，缺失事实才允许逐项消失。

## 14. 迁移与上线顺序

1. 增加六张表、索引与迁移；
2. 增加 SQLite Manufacturing Context Store；
3. 实现 Projector、租约、重试、死信和回放；
4. 接入 PO 主链业务事务的原子投影任务；
5. 对现有 PO 执行只读语义回填；
6. 增加查询 API、快照创建和 Agent Event；
7. 在 PO 详情接入制造上下文页签；
8. 对指定真实 PO 做 SQLite、API、Web、审计和幂等验收；
9. 将 Context 门禁接入 V1 readiness，但不改变既有真实闭环门禁结果。

每一步都必须独立通过测试；不允许先写完整实现再补测试。

## 15. 完成定义

本阶段只有同时满足以下条件才算完成：

- 六张表与迁移在真实 v34 SQLite 上成功运行；
- 业务事实与投影任务同事务写入；
- Projector 可恢复、可重试、可死信、可审计重放；
- 事实优先级和证据链可验证；
- Agent 使用不可变快照并在 Agent Event 中引用；
- API 与 UI 严格租户隔离并完成字段脱敏；
- PO 详情能够显示真实制造上下文、缺失事实和投影健康；
- 指定真实 PO 通过第 13.4 节验收；
- 没有伪造 Odoo、供应商、生产、发运、收货或 GRN 成功；
- 全量自动化测试、TypeScript 类型检查和 Console 构建通过。

## 16. 后续层的边界

Context/Twin 完成后：

- Eval/Governance 消费 `twin_snapshots`、`twin_agent_events`、业务结果和人工反馈，构建 Northstars、回归评测、生产审计和版本比较；
- Workspace/App 消费稳定的 Context 查询 API 与 Workflow API，构建专业工作台和后续可扩展 App；
- 两个后续层不得绕过 Action Gateway 直接执行外部副作用。
