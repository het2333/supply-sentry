# Hermes Gateway 官方组件直接集成规格

## 1. 状态与取代关系

本规格取代 `2026-09-08-hermes-inspired-messaging-gateway-boundaries-design.md` 中“不安装、嵌入或运行 Hermes”的决定。旧规格已经落地的 Inbox、Outbox、审批、幂等、投递歧义、熔断、审计和采购桥接继续保留；渠道连接层改为直接运行 Hermes Gateway 官方组件。

本工作区不是 Git 仓库，因此无法执行规格要求中的提交步骤。所有变更直接落在当前工作区，并以测试、构建、容器健康和端到端探针作为交付证据。

## 2. 目标与完成定义

Readywork 必须支持 Hermes 官方 Gateway 在固定版本中公开的全部消息平台，而不是在 TypeScript 中逐个复刻适配器。

“支持”有三个互不混淆的状态：

1. **可配置**：渠道来自运行中的 Hermes 官方动态目录，Readywork 能显示其配置字段、文档入口和真实状态。
2. **已配置**：当前租户对应的 Hermes profile 已保存该渠道所需配置，但不代表连接成功。
3. **已连接**：Hermes 的真实测试或运行时状态证明渠道可用。

没有真实第三方凭据时，交付最多声明“可配置”或“未配置”，不得用 Mock、静态假数据或本地成功提示冒充“已连接”。

本期完成必须同时满足：

- 固定并运行 Hermes Agent 官方镜像 `v2026.9.7`，manifest 摘要固定为 `sha256:63bfb6d732f49a55d453e801057273785cc61e0f6ee43db3fa2f2a79846301b7`，源码提交固定为 `2237be355906fbe6065ce1815711eee52b2d646e`；
- Readywork 从 Hermes `Platform enum + platform_registry` 生成的 `/api/messaging/platforms` 获取唯一渠道目录；
- Hermes 当前和未来同兼容版本新增的平台无需修改 Readywork 渠道枚举即可显示；
- Readywork 管理员可以查看、配置、启停、测试渠道，并完成 Hermes 提供的 onboarding 流程；
- 所有外部入站先持久化到 Readywork Inbox，再进入采购识别与 DeepSeek 原文分析；
- 所有采购出站仍由 Readywork 审批后的 Outbox 发起，经 Hermes 投递并保存真实回执；
- 未知发送结果不自动重发，Email 迁移期禁止双路发送；
- 前端全部使用中文产品文案，协议名和官方平台品牌名保留原名；
- 后端、前端、插件、容器和端到端验证均通过。

## 3. 已比较方案与决策

### 3.1 采用：官方 Sidecar + Readywork Bridge

Hermes 官方源码作为独立容器或进程运行；Readywork 通过版本化桥接合同连接管理 API、入站 Hook 和出站投递入口。Readywork 不修改 Hermes 核心源码。

优点是直接继承官方全部适配器和升级路径，同时保住采购系统的审批、幂等和证据边界。代价是引入 Python/Node Sidecar、运行时配置和跨进程健康管理。

### 3.2 拒绝：在 Readywork 逐个重写适配器

这种方式会长期追赶 Hermes 的平台更新、授权变化和媒体处理差异，无法满足“官方支持的都要支持”。

### 3.3 拒绝：Fork Hermes 并把采购逻辑写进核心

这种方式短期直接，但会造成升级冲突，并把订单、审批和供应商证据耦合到通用 Agent 运行时。

## 4. 总体架构与权威边界

```text
供应商 / 企业消息平台
          ↕
Hermes Gateway v2026.9.7（官方适配器、连接、onboarding、平台测试）
          ↕ 官方管理 API / 受认证的 Weixin onboarding 侧车
Readywork API（租户 profile 映射、权限、审计、凭据脱敏）
          ↕ HMAC 版本化 Bridge 合同
Readywork Messaging Gateway（Inbox、Outbox、幂等、熔断、投递账本）
          ↕
采购业务（PO 匹配、身份校验、DeepSeek 分析、审批、状态投影、审计）
```

权威归属固定如下：

- Hermes 是渠道目录、渠道配置、连接状态和渠道协议实现的权威来源。
- Readywork 是租户、采购对象、供应商身份、审批、Inbox、Outbox、投递状态、AI 分析和业务状态的唯一权威来源。
- Hermes 不得直接创建或修改采购订单、收货、路线、发票或 Odoo 状态。
- Hermes 的通用 Agent、终端、危险工具和自动回复不得处理供应商采购通道；Bridge 在 `pre_gateway_dispatch` 阶段截获外部消息并返回 `skip`。

## 5. Hermes 运行与版本固定

### 5.1 构建与运行

新增 `infra/hermes/compose.yml`，直接使用 Hermes 官方发布镜像，同时固定 tag、manifest digest 和对应源码提交。这样既保留可审计、可复现性，也避免每次部署依赖上游 Dockerfile 的外部 APT 构建链路。

容器必须：

- 将可变状态挂载到项目数据目录下的独立 Hermes volume；
- 开启 Hermes Dashboard 管理服务和 Gateway；
- 在固定版本 Dashboard 未公开 Weixin 扫码 HTTP 接口时，同容器运行受认证的 onboarding 侧车；
- 仅向主机回环地址暴露管理端口；
- 管理服务使用独立服务凭据，Readywork 后端持有凭据，浏览器不接触凭据；
- 开启首启 Gateway 状态并保留重启状态；
- 挂载 Readywork Bridge Plugin，只读挂载插件源码，可写目录仅限 Hermes 数据和 Bridge spool；
- 不把 Readywork、DeepSeek、SMTP 或第三方渠道密钥写入源码、镜像或前端响应。

### 5.2 租户映射

每个 Readywork 租户映射到一个经过规范化和碰撞检测的 Hermes profile。映射持久化，不直接使用可控租户字符串作为文件路径。默认租户同样拥有显式 profile，不共享全局凭据。

第一阶段使用 Hermes 官方 `multiplex_profiles` 模式，由一个默认 Gateway 进程为多个隔离 profile 提供连接。Readywork 首次读取租户渠道时幂等创建缺失的命名 profile；绑定独立监听端口的平台若与多 profile 冲突，必须将冲突原样呈现为不可启用原因，不得静默覆盖其他租户。

## 6. 官方动态渠道目录

Readywork 新增 `HermesControlClient`，代理 Hermes Dashboard 的管理合同：

- `GET /api/messaging/platforms`
- `PUT /api/messaging/platforms/{platform_id}`
- `POST /api/messaging/platforms/{platform_id}/test`
- Hermes WhatsApp onboarding API
- Hermes Telegram onboarding API
- Readywork Weixin onboarding 侧车（复用 Hermes 原生 iLink 实现）
- `GET /api/health`
- `GET /api/status`

客户端负责：

- 短期缓存服务访问令牌并在 401 后刷新一次；
- 超时、最大响应体、JSON 形状和上游状态码校验；
- profile 参数固定来自已认证 Readywork 租户映射；
- 日志和错误脱敏；
- 绝不向浏览器返回环境变量的已保存值、服务凭据或 Hermes 文件路径。

前端不得维护平台枚举。平台品牌名来自 Hermes，Readywork 只维护中文解释和通用状态文案。当前固定版本的目录包含 Telegram、Discord、Slack、Mattermost、Matrix、WhatsApp、WhatsApp Cloud API、Signal、BlueBubbles、Email、SMS、Home Assistant、钉钉、飞书、Google Chat、企业微信、企业微信回调、微信、QQ、元宝、Microsoft Teams、LINE、ntfy、Photon、Raft、IRC、Buzz、SimpleX、A2A、API Server、Webhook、Microsoft Graph Webhook 和 Relay；实际响应以运行中 Hermes 目录为准。

### 6.1 个人微信平台内扫码

Hermes `v2026.9.7` 的 Dashboard 尚未暴露 Weixin `qr_login` HTTP API。Readywork 不修改 Hermes 核心源码，而是在同一受控运行边界内启动 `127.0.0.1:9121` onboarding 侧车，复用 Hermes 原生 `_fetch_qr`、`_api_get` 和 `save_weixin_account`。

流程固定为：管理员在 Readywork 点击“配置微信”→平台生成真实腾讯 iLink 二维码→浏览器轮询脱敏状态→手机确认后侧车保存 `WEIXIN_ACCOUNT_ID`、`WEIXIN_TOKEN`、`WEIXIN_BASE_URL`→通过 Hermes 官方配置 API 启用渠道并重启对应 Gateway profile。

每个租户同时只允许一个活动扫码会话。会话凭据仅存在侧车内存和 Hermes profile secret storage，不返回 Readywork 前端，不进入 Readywork 数据库、日志或审计详情。关闭弹窗会取消未完成会话；二维码过期可受控刷新，未扫码长轮询超时继续映射为“等待扫码”。

## 7. Bridge 合同

### 7.1 版本与认证

Bridge 使用 `readywork.hermes.bridge.v1` JSON 合同。每次请求包含：

- `X-Readywork-Bridge-Version`
- `X-Readywork-Timestamp`
- `X-Readywork-Nonce`
- `X-Readywork-Signature`

签名为共享密钥上的 HMAC-SHA256，覆盖 HTTP 方法、路径、时间戳、nonce 和原始请求体。Readywork 拒绝超过五分钟的请求、重复 nonce、签名不匹配和未知版本。

### 7.2 入站

Hermes 用户插件注册 `pre_gateway_dispatch` Hook：

1. 将规范化 `MessageEvent`、来源、平台消息 ID、回复关系、媒体元数据和原始事件的安全 JSON 视图写入 Hermes 数据卷上的原子 spool 文件；
2. 将媒体文件复制到该 spool 项目的附件目录并记录 SHA-256、大小和 MIME；
3. spool 成功后返回 `{"action":"skip"}`，阻止通用 Agent、配对提示和自动回复；
4. 后台投递器以 HMAC 将 spool 发送到 Readywork `POST /api/integrations/hermes/v1/inbound`；
5. Readywork 在同一事务内保存 Inbox envelope、附件和 nonce 后返回持久化回执；
6. 插件收到回执后才把 spool 项标为已提交并可清理。

平台没有稳定 message ID 时，插件用平台、profile、会话、发送者、时间窗口和内容/附件指纹生成确定性回退 ID。Readywork 仍以租户、适配器和 provider message ID 唯一约束幂等。

Bridge 暂时不可达时，消息保留在 Hermes 数据卷 spool 并指数退避；不得转入通用 Agent，也不得丢弃。spool 容量达到上限时进入阻塞健康状态并停止宣称入站健康。

### 7.3 出站

采购出站继续先写 Readywork Outbox。审批通过后：

1. Readywork 预留 `messaging_deliveries` 幂等记录；
2. 将文本、目标、线程/回复信息和已冻结附件发送至 Bridge 出站入口；
3. Bridge 在 Hermes Gateway 进程内调用对应官方适配器或官方直接投递实现；
4. Bridge 返回 `accepted`、`retryable_before_dispatch`、`failed_before_dispatch` 或 `unknown_after_dispatch`；
5. Readywork 保存真实 provider message ID 和阶段。

任何已经开始外部调用但没有确定回执的情况必须返回 `unknown_after_dispatch`，不得自动重发。Hermes 只接受 Readywork 已签名且带幂等键的出站请求。

为了复用所有在线适配器，Bridge Plugin 同时注册内部 `readywork_bridge` Platform Adapter。Hermes 在连接前为该适配器注入当前 `GatewayRunner`，适配器据此只在 Compose 内网开放 HMAC HTTP 入口，并把经过校验的目标、线程和媒体参数交给同一进程内对应的官方适配器 `send()`。它直接返回 Hermes `SendResult` 的成功标记、真实 message ID、错误种类、可重试标记和 continuation message IDs；内部 bridge 平台从 Readywork 用户渠道目录中过滤，不作为供应商渠道展示。Bridge 不调用 LLM。

Bridge Adapter 在本地 SQLite 中以 Readywork delivery id 和请求指纹做幂等预留。相同 id、相同载荷重放直接返回已保存结果；相同 id、不同载荷返回冲突。进程在调用官方适配器前记录 `dispatching`，崩溃恢复后仍为 `dispatching` 的请求一律映射为 `unknown_after_dispatch`，不再次调用平台。

### 7.4 Email 切换保护

现有 Readywork SMTP/IMAP 是生产回退链路。Email 采用显式单路开关：

- `native`：现有 Readywork Email 适配器收发，Hermes Email 禁用；
- `hermes`：Hermes Email 收发，Readywork 原生轮询和发送禁用；
- 不存在 `both`。

切换前需通过 Hermes Email 测试、入站持久化探针和出站回执探针。发送结果未知时保留人工核对，不回退到另一条链路重发。

## 8. Readywork 后端 API

在现有 `/api/messaging` 下新增：

- `GET /api/messaging/platforms`：动态目录、配置状态、连接状态和管理权限；
- `PUT /api/messaging/platforms/:id`：管理员配置/启停，要求 `Idempotency-Key`；
- `POST /api/messaging/platforms/:id/test`：管理员触发真实测试；
- `POST|GET|DELETE /api/messaging/onboarding/:platform/...`：白名单代理 Hermes onboarding 操作；
- `GET /api/messaging/hermes/health`：合并 Dashboard、Gateway、Bridge spool 和 Readywork Inbox/Outbox 健康；
- `POST /api/integrations/hermes/v1/inbound`：仅 HMAC Bridge 调用，不使用浏览器会话；
- `POST /api/integrations/hermes/v1/delivery-receipts`：可选异步投递回执入口。

所有 mutation 均要求管理员权限、租户 profile 隔离、幂等键、审计记录和字段白名单。配置 API 只接受 Hermes 目录声明的环境变量名；不允许客户端写任意文件、任意环境变量、任意 URL 或任意 profile。

## 9. 持久化

新增迁移保存：

- `hermes_tenant_profiles`：租户与 profile 的不可变映射；
- `hermes_platform_snapshots`：最后一次成功目录/状态快照，只用于上游不可达时标记为“过期快照”；
- `hermes_bridge_nonces`：入站防重放 nonce 和过期时间；
- `hermes_bridge_receipts`：Bridge 请求、Readywork Inbox/Delivery ID、结果和时间；
- `hermes_platform_actions`：配置、启停、测试和 onboarding 审计，不保存密钥值。

渠道凭据仍保存在 Hermes profile 的 secret storage；Readywork 数据库只记录字段是否已配置和不可逆指纹，不保存明文。

## 10. 前端交互

设置页将现有 Email-only 运行卡升级为“消息渠道”工作台：

- 顶部展示 Hermes Sidecar、Bridge、Inbox/Outbox 的合并健康；
- 搜索、按状态筛选并显示 Hermes 返回的全部渠道；
- 每张渠道卡显示品牌、中文说明、可配置/已配置/已连接状态、所需字段数量、最近测试和真实错误；
- 管理员可打开配置抽屉，敏感字段只显示“已保存/未保存”，编辑时不回填；
- 渠道测试有进行中、成功、失败和超时状态；
- WhatsApp/Telegram 使用 Hermes onboarding 界面；个人微信在同一 Readywork 配置弹窗内生成 iLink 二维码、自动检查并自动保存；
- 个人微信排在 Hermes 渠道首位，旧企业微信占位卡不再与它并列，避免把“个人微信可扫码”误解为“微信不可配置”；
- 二维码和临时 pairing 数据不持久化到浏览器存储；
- 未配置渠道不显示暂停/恢复为主要动作，而显示“开始配置”；
- 上游不可达且存在快照时，清楚显示“过期快照”，禁用 mutation；
- 协议品牌名可保留英文，按钮、状态、错误和解释全部中文。

## 11. 安全与业务限制

- Hermes Dashboard 和 Bridge 只绑定回环或 Compose 内网，不直接暴露公网。
- Readywork 后端是浏览器访问 Hermes 的唯一代理。
- Weixin onboarding 侧车仅绑定回环地址，与 Dashboard 共用受保护的会话令牌，且拒绝非 Readywork 命名 profile。
- 供应商平台默认使用允许列表和供应商身份映射；生产环境禁止 `ALLOW_ALL_USERS`。
- Bridge Plugin 不注册终端、文件写入、浏览器或任意工具能力。
- 插件只可读取当前入站媒体路径并复制到受限 spool，拒绝符号链接、路径穿越、超大文件和超限附件总量。
- 所有外部文本均为不可信数据，不解释为 Readywork 指令。
- DeepSeek 只分析已经持久化的供应商原文；缺失 API Key 时保留原文并标记待分析，不伪造结构化结果。
- 已在历史对话中暴露的 DeepSeek Key 必须轮换，源码和日志不得复述该值。

## 12. 故障处理与可观测性

健康状态至少区分：

- `unsupported`：Hermes 目录不存在该平台；
- `unconfigured`：支持但缺少配置；
- `configured`：配置完整但未证明连接；
- `connected`：真实运行时证明连接；
- `degraded`：连接或 Bridge 延迟异常；
- `paused`：管理员暂停；
- `blocked`：spool 已满、签名失败或投递结果未知需要人工介入；
- `unreachable`：Hermes 管理面不可达。

Readywork 不因 Hermes 不可达而停止核心采购 API。管理面失败保留最近成功快照但标为过期；出站留在 Outbox，入站由 Hermes spool 保留。Email 原生回退只允许通过显式单路切换启用。

## 13. 测试策略

严格遵循测试先行：

1. 合同测试：Hermes 目录、登录、401 刷新、超时、响应体限制、错误脱敏和 profile 隔离；
2. 路由测试：读取、配置、测试、onboarding、权限、幂等和审计；
3. 插件测试：事件规范化、附件冻结、原子 spool、HMAC、防重放、失败保留和成功确认；
4. 投递测试：`accepted`、调用前失败、调用后未知和禁止重发；
5. 持久化测试：迁移、唯一约束、租户隔离和快照过期；
6. 前端交互测试：动态未知渠道、中文状态、配置表单、敏感字段不回填、微信二维码、自动轮询/保存、取消会话、过期快照和 mutation 禁用；
7. Weixin 侧车单元测试：租户隔离、单活动会话、等待/扫码/确认/过期/取消状态、不泄露凭据和 Gateway 重启；
8. 容器验证：拉取固定 tag + manifest digest 的官方镜像，验证 `/api/health`、`/api/status`、Weixin onboarding 健康和动态目录；
9. 真实端到端探针：在无第三方凭据时至少验证官方全目录、未配置诚实状态、真实 iLink 二维码、未扫码持续等待、取消会话、配置 mutation 到独立测试 profile、HMAC 入站落库和出站调用前失败；只有用户在手机微信确认后才声明个人微信已连接。

## 14. 切换顺序

1. 固定 Hermes 运行工件并通过容器健康；
2. 实现 Control Client 与动态目录只读代理；
3. 完成设置页动态目录和诚实状态；
4. 实现 Bridge HMAC、spool 和入站持久化；
5. 实现审批后出站和投递回执；
6. 接入配置、测试和 onboarding mutation；
7. 完成单租户和跨租户测试；
8. 保持 Email `native`，完成影子验证后再显式切到 `hermes`；
9. 对每个提供真实凭据的渠道分别记录连接和收发证据。

## 15. 非目标

- 不把 Hermes 通用聊天 Agent 变成采购系统权威；
- 不保证没有第三方账号、Token、手机号、Bot 或公网 Webhook 的渠道自动连接；
- 不伪造供应商消息、订单、Shipment、Receipt、GRN 或 Odoo 回执；
- 不为了显示“全支持”而静态复制一份渠道目录；
- 不在本期修改或维护 Hermes 核心私有 Fork。
