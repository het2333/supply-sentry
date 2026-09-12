# Readywork P2 运行时架构

P2 保留现有采购业务能力，但将“怎么执行”从业务 API 中拆成独立控制面。业务人员仍只看到一个采购执行员工；开发者在 Editor 中编排其内部专业节点。

## 分层

1. Editor / Control Plane
   - 节点描述、草稿、发布版本、RuleSet、Connector 与 Credential 元数据。
   - 工作流发布后生成不可变 `WorkflowVersion`。
2. Graph Runtime
   - `NodeTypeDescriptor` 统一声明名称、图标、输入、输出、参数、Credential、执行器和副作用。
   - `NodeFactory` 按 `type@version` 注册执行器，新增节点不修改编排引擎。
   - `VariablePool` 保存节点变量并解析 `{{ selector }}` 表达式。
   - 图校验覆盖节点类型、必填参数、端口、悬空边和循环。
3. Temporal Durable Runtime
   - 每次 Editor 运行创建真实 Temporal Workflow。
   - `approval` Signal 恢复审批节点；`externalEvent` Signal 恢复等待节点；`runState` Query 返回当前状态。
   - `WorkflowRun`、`NodeRun` 与面向采购用户的 `BusinessActivity` 持久化到控制面数据库，Temporal 保存可重放事件历史。
4. DeepSeek Harness Agent Runtime
   - `AgentRuntimePort` 是平台与 Agent Kernel 的稳定边界；默认 Provider 为 `dsh`，测试与确定性回归才显式使用 `inmemory`。
   - Temporal 遇到 AI 节点时，通过 Activity 调用 DeepSeek Harness；条件、等待、审批和 Connector 节点不进入 Agent Loop。
   - Harness 负责模型调用、Agent Loop、Session、上下文压缩、Skills 与 Subagents，但不拥有业务流程状态。
   - AI 节点只返回分析、结构化输出与动作建议；建议中的外部副作用不能由 Harness 直接执行。
   - Harness 以受管子进程运行，每个员工复用自己的 Runtime 与 Session 目录；缺少 Runtime 或模型配置时明确失败，不静默切回确定性桩。
   - 默认使用 decision-only Cordis，不加载 Bash、文件系统、MCP、ERP 或邮件工具；子进程只继承安全白名单环境变量。
5. Action Gateway
   - 所有外部副作用统一经过运行模式、员工权限、幂等键和审计检查。
   - 模拟与影子模式拦截副作用；审批模式收到 Signal 后执行；自动模式只允许已发布版本。
6. Connector Runtime
   - Connector 统一声明 Credential 与 Actions。
   - Credential 字段使用声明式 Schema；控制台按字段类型、必填项、默认值和密钥标记自动生成配置表单，保存后不会回显密钥。
   - 内置连接器通过适配器调用现有工具；客户连接器可使用隔离子进程的 NDJSON 协议。
   - 本地插件由运行时监管并常驻复用，具备并发上限、执行超时、异常退出回收和优雅关闭；只继承白名单环境变量。
   - Credential 使用 AES-256-GCM 加密；没有 `READYWORK_CREDENTIAL_KEY` 时拒绝保存，而不是明文降级。
   - 安装生命周期为 `available → installing → installed / failed → disabled`，支持启用、升级与卸载。
   - Credential 测试状态为 `untested / connected / partial / failed`；安装、凭据保存、测试和删除都写租户级事件审计。
   - HTTP 等客户 Connector 在隔离子进程中执行，安装时必须声明可访问主机。

## Connector 控制面

“工具与连接”页面读取真实控制面数据，按搜索词和业务分类浏览连接器，并展示安装状态、运行时、健康状态、凭据数量、连接状态、可调用动作和风险等级。用户可以在同一页面完成安装、启用、停用、升级、卸载、配置凭据和连接测试；所有变更刷新后仍由数据库恢复。

首批目录包含 14 个连接器：

- 基础能力：企业邮箱、采购台账、HTTP、Webhook、数据库。
- ERP：Readywork ERP、SAP S/4HANA、金蝶云、用友。
- 协同：企业微信、钉钉、飞书。
- 制造系统：WMS、MES。

HTTP Connector 已以 `local_process` 方式安装，当前主机白名单仅允许 `127.0.0.1` 与 `localhost`。客户连接器故障不会与控制面运行在同一个进程中。

Webhook Connector 使用独立的内置事件适配器，不依赖旧工具注册表。外部系统向 `POST /api/connectors/webhook/{tenant_id}/{credential_id}` 发送 JSON，并在 `X-Readywork-Signature` 中提供 `sha256=<HMAC-SHA256>`；控制面以加密保存的 Webhook Secret 验签，通过后生成标准事件并记录审计，失败签名不会进入工作流。

邮箱 Credential 已接入真实 SMTP/IMAP 测试：SMTP 可用时可独立标记成功；若 SMTP 成功但 IMAP 被邮箱服务商拒绝，则凭据状态为 `partial`，控制台展示准确的账号侧处理提示。

本地 Odoo 19 已作为首个真实 ERP 客户系统接入。ERP Credential 保存 `baseUrl`、`database` 与 `apiKey`，由 Credential Vault 加密；连接测试会真实调用 Odoo JSON-2 API。业务面不再在进程启动时按固定 `TENANT_ID` 创建全局 Odoo Client，而是由 `OdooRuntimeResolver` 在每个请求或 Outbox 租约领取后按当前 tenant 解析 Connector Control Plane 的 `erp / erpCredential`。只有 connector 未停用、credential 为 `connected`、存在 `last_tested_at`、`last_error IS NULL` 且密文可解密时才能获得 Client；轮换、删除、重新测试或停用会通过持久化版本和密文摘要自然使缓存失效。采购快照、供应商主数据、PO / GRN / 发票读取、三单异常和 ERP Outbox 共用该 resolver，绝不跨租户 fallback。持久化审计只保留 `credentialId / credentialVersion / lastTestedAt` 与动作名，不保存 endpoint、database、API key、密文或原始外部载荷。

已安装的 HTTP、Webhook 等非默认 Connector 会在控制面重启时根据持久化安装配置自动重新注册。SQLite 在业务面与控制面并发启动时使用忙等待配合 WAL，避免初始化阶段的瞬时争锁导致服务退出。

## Workforce 与租户模型

- `EmployeeDefinition` 保存稳定岗位身份；`EmployeeVersion` 保存不可变能力与 Spec 快照；`EmployeeDeployment` 保存当前版本、运行模式、规则、权限和 Connector 授权。
- Editor、WorkflowVersion、WorkflowRun、NodeRun、RuleSet、Credential、Connector Installation 和 Action Execution 均以 `tenant_id` 为第一隔离键。
- 旧运行表保留不删；版本化迁移将旧数据复制到 `runtime_*` 复合主键表。旧全局 Editor 数据只迁给采购员工，误复制数据进入 quarantine 后恢复员工自己的能力包。
- 签名会话携带 `tenantId`；角色权限分为 read、operate、approve、configure、admin。生产环境必须设置 `READYWORK_SESSION_SECRET`，且默认禁用演示账号。

## 服务边界

- `apps/business-api`：任务、审批、异常、业务对象、Odoo 和业务事件。
- `apps/control-plane-api`：Editor、Rules、员工配置、Connector、Credential 与 Temporal 内部回调。
- `apps/api`：兼容门面；可通过 `READYWORK_API_SURFACE=compat|business|control` 部署，路由白名单会阻止跨面访问。
- 控制面不会轮询邮箱、恢复旧任务或注入演示任务；业务面和控制面可独立升级。
- 旧 `WorkflowEngine` 只承担历史任务兼容，新图运行统一进入 `workforceGraphWorkflow`。
- `apps/temporal-worker` 持有默认 `AgentRuntimePort`，AI Node Activity 调用 Harness；Worker 关闭时同步回收 Harness 子进程。
- Connector 安装、凭据、测试结果与事件表均以 `tenant_id` 隔离；密钥只在执行时解密并传给目标 Adapter，列表接口永不返回明文值。

## Agent Runtime 边界

```text
Temporal Workflow
      ↓ AI Node Activity
AgentRuntimePort
      ↓
DeepSeek Harness（思考、Session、Skills、Subagents）
      ↓ 结构化结果 / 动作建议
Action Gateway（权限、审批、幂等、副作用、审计）
      ↓
Connector Runtime（ERP、邮箱、WMS、MES）
```

`READYWORK_AGENT_RUNTIME` 默认值为 `dsh`。生产运行至少配置：

- `READYWORK_DSH_REPO`：经过验证并固定版本的 DeepSeek Harness checkout。
- `DEEPSEEK_API_KEY`：远端模型凭据；只有显式 localhost/loopback 的 `DEEPSEEK_BASE_URL` 可无密钥运行。
- `READYWORK_DSH_PROVIDER`、`READYWORK_DSH_MODEL`：默认模型路由。
- `READYWORK_DSH_REASONING_EFFORT`：默认推理强度（`off`、`low`、`medium`、`high`、`max`）。
- `READYWORK_DSH_MAX_TOKENS`：默认单次 Agent 请求输出上限（128–131072）。
- `READYWORK_DSH_AGENT_PROFILES`：仅服务端可设置的 JSON 路由，按 `workers` 优先于 `employees` 覆盖模型、推理强度和 token 预算；任务输入和模型输出无法覆写。每种路由使用隔离 Harness 进程，避免不同预算复用。

`READYWORK_DSH_COMMAND`、`READYWORK_DSH_ARGS`、`READYWORK_DSH_CORDIS` 可替换默认子进程启动方式；超时、工作目录和 Session 目录也均通过 `READYWORK_DSH_*` 配置。`READYWORK_DSH_ENV_ALLOWLIST` 只在确有需要时追加可继承的父进程变量名。控制面展示配置目标、Provider、模型、隔离方式与是否已观测到 Worker，不把“配置有效”误报成“进程就绪”，也不返回 API Key、路径等环境变量值或 Harness 内部事件。

## 标准邮件节点

`connector.email.send_supplier_email@1`：

- 输入：`supplier_id`、`subject`、`body`、`attachments`
- 输出：`message_id`、`sent_at`
- Credential：`emailCredential`，scope `email.send`
- Executor：`connector:email.send`
- 副作用：发送外部邮件

Editor 组件库和右侧配置面板直接由该描述生成，不再维护一份重复的前端表单定义。

## 本地服务

- 业务面 API：`127.0.0.1:4173`
- P2 控制面 API：`127.0.0.1:4174`
- Web 控制台：`127.0.0.1:3001`
- Temporal：`127.0.0.1:7233`
- Task Queue：`readywork-workforce`

业务面与控制面可独立升级；控制台通过同源 `/api` 路径访问两者。

本地启动：

```text
pnpm api:business
pnpm api:control
pnpm temporal:worker
pnpm console
```

生产环境额外要求：`READYWORK_SESSION_SECRET`、`READYWORK_CREDENTIAL_KEY`、DeepSeek Harness 与模型配置，以及相同的 Temporal namespace/task queue 配置。
