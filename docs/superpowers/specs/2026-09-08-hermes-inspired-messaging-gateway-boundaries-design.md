# Hermes 启发的消息网关与业务边界重构规格

## 1. 背景与目标

Readywork 当前已经能够通过真实 SMTP 发送采购邮件、通过 IMAP 接收供应商回复、通过 WhatsApp Webhook 接收状态与消息，并使用持久化采购 Outbox、Message-ID、幂等键和审计事实保证业务真实性。但是，渠道生命周期、入站持久化、投递账本、业务关联、AI 提取和采购状态变更仍散落在 API 启动文件与采购模块中。

本次重构吸收 Hermes Messaging Gateway 的以下架构思想：

- 单网关管理多个渠道适配器；
- 适配器能力显式声明；
- 每个渠道拥有可观测的运行、暂停和熔断状态；
- 最终投递由持久化账本保护；
- 入站消息先可靠接收，再交给业务处理；
- 渠道故障不能拖垮其他渠道或业务 API。

Readywork 是企业采购执行系统，不是通用聊天机器人。因此本次不复制 Hermes 的聊天会话、斜杠命令、人物设定、模型切换或终端权限模型。Readywork 的权威上下文仍是租户、业务对象、审批、供应商主数据、订单行和外部系统回执。

## 2. 决策

采用“领域 Outbox + 通用消息网关 + 领域桥接器”三层方案。

### 2.1 已比较的方案

1. **直接部署 Hermes 并把邮件接入 Hermes**：开发快，但引入 Python 运行时、Hermes 会话存储和聊天权限模型；采购证据将跨两套数据库，且难以保证 Outbox、审批和 Odoo 回读仍为唯一权威链路。拒绝。
2. **仅把现有 SMTP/IMAP 文件改名为 gateway**：改动小，但不会解决业务代码直接控制渠道、缺少统一投递账本、缺少适配器状态机和熔断的问题。拒绝。
3. **保留采购领域事实，新增 Readywork 原生消息网关**：复用现有 TypeScript、SQLite、连接器凭据、Outbox 和 Temporal，同时建立清晰边界。采用。

## 3. 业务边界

### 3.1 采购领域

采购领域负责：

- 决定为什么要联系供应商；
- 生成并冻结供应商、收件人、主题、正文、附件和业务版本；
- 执行审批与权限判断；
- 创建 `procurement_outbox` 业务命令；
- 将已关联的入站消息投影成 `Communication`；
- 将 AI 候选事实交给确定性业务规则；
- 只有经过证据门禁的领域命令才能改变路线、承诺、生产、发运和收货事实。

采购领域不再负责建立 SMTP/IMAP 连接、判断渠道是否熔断、管理渠道重试或解释供应商平台回执。

### 3.2 消息网关

消息网关负责：

- 管理渠道适配器的注册、能力、启动、关闭、健康、暂停和恢复；
- 把领域给出的发送命令规范化成渠道无关的投递请求；
- 在外部 I/O 前创建持久化投递账本；
- 记录投递尝试、真实服务商 Message-ID、接受时间、状态和不确定结果；
- 把渠道入站事件规范化成不可变消息信封并先持久化；
- 向注册的领域桥接器派发已持久化入站消息；
- 对连续可重试故障执行单适配器熔断；
- 输出脱敏的运行状态和操作审计。

消息网关不理解 PO 阶段、路线、单价差异、ASN、GRN 或审批策略，也不能直接写采购事实。

### 3.3 渠道适配器

每个适配器只负责一个外部协议。第一阶段迁移 Email；随后迁移 WhatsApp 与 Teams。

适配器必须声明：

- `send_text`、`send_attachments`、`receive`、`threads`、`delivery_receipts` 等能力；
- 实例标识、渠道、提供商和凭据引用；
- `health()`、`send()`、可选 `poll()` 或 Webhook 规范化入口；
- 外部调用是否尚未开始、已经开始但结果不确定、或已被提供商明确接受。

适配器不能访问采购仓储。

### 3.4 领域桥接器

`ProcurementMessagingBridge` 是消息网关与采购领域之间唯一的入站边界。它负责：

- 依据租户、登记供应商身份、Message-ID 线程和 PO 编号解析业务对象；
- 将网关消息信封转换为采购 `Communication`；
- 记录无法关联、发件人不可信、附件不安全等拒绝事实；
- 调用 DeepSeek 结构化提取；
- 调用采购命令服务应用有逐字引用支持的候选事实。

桥接器可以读取采购事实，但不能管理渠道连接或投递重试。

### 3.5 AI 提取

DeepSeek 仅消费已持久化、已完成可信关联的当前回复文本。AI 输出必须继续满足：

- 每个应用字段都包含当前回复中的逐字原文引用；
- 原始引用邮件、签名和转发历史不作为当前供应商陈述；
- 证据来源标记为 `supplier_email_ai`；
- AI 结果不能冒充人工核验、Odoo 或 WMS 事实；
- 缺失、冲突或歧义字段保持阻断，不用 PO 原值补齐。

## 4. 通用合同

新建 `@readywork/messaging` 包，提供不依赖采购领域的合同和内核。

### 4.1 消息信封

```ts
export type MessagingChannel = 'email' | 'whatsapp' | 'teams';

export interface InboundMessageEnvelope {
  id: string;
  tenantId: string;
  adapterId: string;
  channel: MessagingChannel;
  provider: string;
  providerMessageId: string;
  conversationId?: string;
  inReplyTo?: string;
  references: string[];
  sender: { address: string; displayName?: string };
  recipients: Array<{ address: string; displayName?: string }>;
  subject?: string;
  text: string;
  attachments: MessageAttachmentDescriptor[];
  occurredAt: string;
  receivedAt: string;
  rawFingerprint: string;
}
```

网关信封不包含 `poId`、`supplierId` 或采购阶段。这些只存在于领域桥接结果中。

### 4.2 投递请求与回执

```ts
export interface MessageDeliveryRequest {
  tenantId: string;
  adapterId: string;
  channel: MessagingChannel;
  idempotencyKey: string;
  sender?: { address?: string; displayName?: string };
  recipients: Array<{ address: string; displayName?: string }>;
  subject?: string;
  text: string;
  attachments: MessageAttachmentPayload[];
  thread?: { inReplyTo?: string; references?: string[] };
  trace: { source: string; sourceId: string; correlationId: string };
}

export interface MessageDeliveryReceipt {
  deliveryId: string;
  status: 'accepted' | 'failed' | 'unknown';
  providerMessageId?: string;
  acceptedAt?: string;
  attempt: number;
  replayed: boolean;
  error?: string;
}
```

### 4.3 适配器状态

适配器实例状态为：

- `running`：健康且可派发；
- `degraded`：最近调用失败，但未达到熔断阈值；
- `paused`：管理员主动暂停；
- `paused_by_breaker`：连续三个可重试故障后熔断；
- `disabled`：配置明确禁用；
- `unconfigured`：缺少已验证凭据。

同一租户同一适配器在五分钟窗口内连续三个可重试故障后进入 `paused_by_breaker`。成功调用清零连续失败。熔断后不会自动恢复；管理员恢复时清零故障计数并写审计事件。

## 5. 持久化模型

Migration 53 新增以下通用表，所有表均以租户隔离。

### 5.1 `messaging_inbound_messages`

- 唯一键：`(tenant_id, channel, adapter_id, provider_message_id)`；
- 保存规范化信封 JSON、原始指纹、处理状态、接收时间；
- 状态：`received`、`dispatching`、`processed`、`rejected`、`failed`；
- 领域派发失败不会删除入站消息，重启后可安全重放；
- 不保存连接器密钥或完整原始协议载荷。

### 5.2 `messaging_deliveries`

- 唯一键：`(tenant_id, adapter_id, idempotency_key)`；
- 保存脱敏且冻结的投递请求、状态、尝试次数、租约、外部调用阶段和最终回执；
- 状态：`pending`、`sending`、`accepted`、`retry_wait`、`unknown`、`failed`、`abandoned`；
- `accepted` 只在服务商明确接受后写入；
- SMTP DATA 是否被接受不明确时进入 `unknown`，不得自动重复发送；
- 外部调用尚未开始的安全失败最多重试三次；
- 已接受行长期保留为采购证据，不按聊天产品的七天策略删除。

### 5.3 `messaging_adapter_states`

- 主键：`(tenant_id, adapter_id)`；
- 保存状态、能力、最近健康检查、连续失败次数、最后错误、暂停原因和版本；
- 所有错误在落库前脱敏。

### 5.4 `messaging_gateway_events`

- 记录适配器启动、健康变化、熔断、恢复、入站接收、领域处理和投递状态变化；
- 不写正文、附件内容、凭据或模型提示；
- 作为运维审计，不作为采购业务事实。

### 5.5 `messaging_gateway_actions`

- 唯一键：`(tenant_id, idempotency_key)`；
- 保存暂停/恢复动作、请求指纹、适配器版本、操作者、脱敏原因和响应；
- 相同键和相同请求返回原响应，不重复递增适配器版本；
- 相同键和不同请求返回幂等冲突。

### 5.6 与现有采购表的关系

- `procurement_outbox.id` 通过投递请求的 `trace.sourceId` 关联 `messaging_deliveries`；
- `procurement_outbox` 仍是审批后业务命令和冻结业务负载的权威来源；
- `messaging_deliveries` 是渠道 I/O 和外部回执的权威来源；
- 网关返回 `accepted` 后，采购 Outbox 才能完成；
- `Communication` 通过网关入站消息 ID 与提供商 Message-ID 保留来源；
- 迁移不回填虚构回执。历史已派发 Outbox 继续使用其原有连接器回执，新投递才进入网关账本。

## 6. 数据流

### 6.1 出站

1. 采购规则生成草稿。
2. 人工或已发布策略完成审批。
3. 采购领域创建冻结的 `procurement_outbox`。
4. `ProcurementOutboxWorker` 领取租约并构造 `MessageDeliveryRequest`。
5. `MessageGateway.deliver()` 以幂等键创建或读取 `messaging_deliveries`。
6. 网关检查适配器状态和能力后调用 Email 适配器。
7. 网关在事务中保存真实 Message-ID 和回执。
8. 采购 Worker 仅在网关返回 `accepted` 时完成采购 Outbox。
9. `unknown` 进入人工核对，不自动重发，也不推进采购事实。

### 6.2 入站

1. Email 适配器有界轮询 IMAP，解析 MIME 并生成网关信封。
2. `MessageGateway.ingest()` 先幂等写入 `messaging_inbound_messages`。
3. 网关调用 `ProcurementMessagingBridge.handle()`。
4. 桥接器执行供应商身份与线程/PO 关联，写入 `Communication` 或拒绝事实。
5. 已可信关联的正文进入 DeepSeek，业务规则按路线、承诺、生产、Shipment 顺序应用可验证字段。
6. 领域处理成功后，网关把入站行标记为 `processed`。
7. 只有第 2 步已经成功持久化且本轮处理结果可重放时，IMAP 邮件才标记为已读。

## 7. 运维 API 与前端

控制面新增：

- `GET /api/messaging/gateway`：返回脱敏网关摘要、每个适配器状态、能力、最近健康检查、连续失败和待处理数量；
- `POST /api/messaging/adapters/:adapterId/pause`：管理员暂停适配器，要求原因和 `Idempotency-Key`；
- `POST /api/messaging/adapters/:adapterId/resume`：管理员恢复适配器，要求原因、期望版本和 `Idempotency-Key`；
- `GET /api/messaging/deliveries?status=unknown|failed|abandoned`：管理员读取脱敏异常投递；
- 现有人工 IMAP 检查 API 保留，但内部改为调用网关适配器。

Configuration 的通信连接卡改读网关摘要，显示真实 `运行中 / 性能下降 / 已暂停 / 已熔断 / 未配置`。只有管理员可操作暂停/恢复，按钮成功后重新读取服务端事实。页面不能根据凭据存在推断运行健康。

## 8. 可靠性与安全

- 全部写接口要求已登录、同租户权限、幂等键和乐观版本；
- 凭据仍由现有加密 Connector Control Plane 管理，网关只接收运行时解析后的秘密；
- 日志、事件、API 和错误信息统一经过敏感信息脱敏；
- 邮件地址在管理员运维列表中默认遮罩；采购业务详情按现有权限显示；
- 网关不向 AI 暴露凭据、适配器内部状态或原始协议载荷；
- 未登记供应商、发件人不一致和无法关联消息保持拒绝/待人工处理；
- 不用消息渠道回执代替 Odoo/WMS 的路线、Shipment、Receipt 或 GRN 证据；
- 适配器熔断不会删除或伪完成领域 Outbox。

## 9. 切换策略

本次以 Email 完成首个端到端切换：

1. 先加入网关内核、Migration 53 和隔离测试；
2. 将 SMTP 出站接入网关投递账本；
3. 将 IMAP 入站接入网关收件箱与采购桥接器；
4. 增加控制面状态 API 和 Configuration 展示；
5. 重启真实 Business/Control API，确认旧 Outbox 未重复发送；
6. 通过一封真实测试邮件验证发送、回复、关联、AI 提取和页面更新；
7. WhatsApp 与 Teams 迁移为后续独立纵切，不阻塞 Email 与 P00021 闭环。

切换期间不保留“旧路径和新路径同时发送”的双写模式。功能开关只允许在测试数据库启用；正式运行栈在一次重启中切换到唯一网关路径。

## 10. 验收标准

- Email 出站只能经 `procurement_outbox → MessageGateway → EmailAdapter`；
- 同一投递幂等键重复执行不会产生第二封邮件；
- SMTP 明确接受后，网关与采购 Outbox 都保存同一 Message-ID；
- SMTP 不确定结果不会自动重发或标记成功；
- IMAP 消息先存在 `messaging_inbound_messages`，再产生采购 `Communication`；
- 同一提供商消息重放只产生一条网关入站记录和一条采购 Communication；
- 连续三个可重试适配器故障触发熔断，其他适配器与 API 保持可用；
- 管理员暂停/恢复具有权限、幂等、版本和审计测试；
- Configuration 刷新后仍显示数据库中的真实状态；
- DeepSeek 解析和逐字引用约束全部保持；
- 全仓 TypeScript、相关单元/集成测试、Console 构建和真实运行探针通过；
- 真实 P00021 的历史 Outbox 不因迁移重发；
- V1 readiness 只按原 11 项权威业务证据计算。消息网关重构本身不能伪造本地路线或五阶段闭环；11/11 仍必须以真实供应商回复及 Odoo/WMS GRN 为证据。

## 11. 非目标

- 不安装、嵌入或 fork Hermes Agent；
- 不建立通用聊天 Session Store；
- 不实现 Hermes 的斜杠命令、背景会话、语音或终端工具；
- 不在本次纵切迁移 WhatsApp 与 Teams；
- 不改变 Odoo/WMS 权威性；
- 不创建 Mock 订单、Mock 回执、Mock 路线或 Mock GRN；
- 不因为工程测试通过就宣称真实业务达到 11/11。
