# Navisight 公开应用静态 API 合同与 Readywork 对齐矩阵

初始采集日期：2026-08-30（Asia/Shanghai）；最近复核：2026-09-01  
证据来源：初始包 `https://app.navisight.ai/_next/static/chunks/app/page-dd63e152cd2686f4.js`，以及当前包 `https://app.navisight.ai/_next/static/chunks/app/page-4534461a7815b3b1.js`（`401263` bytes，SHA-256 `e4f7dfb3c8f686a69b57862572d44aa2e7ea96be78d3ccc240e2cb9dfa4af7d1`）。本文只解析公开静态包中的客户端调用，不提交表单、不调用第三方写接口、不记录其账户、订单或通知数据。

静态包只能证明“前端期望某个合同”，不能证明服务端权限、幂等、事务、审计或连接器副作用已经生产化。

## 1. 公开客户端合同

| 能力 | Navisight 客户端合同 | 可见方法/动作 | Readywork 当前对应 | 对齐判断 |
|---|---|---|---|---|
| 会话 | `/api/auth/status`、`/auth/login`、`/auth/disconnect` | GET / login / disconnect | Readywork 统一 session + RBAC；本地可选 demo auth | 生产能力更严格；禁止复制无会话 API 暴露 |
| Gmail | `/api/gmail/auth/status`、`login`、`disconnect` | OAuth 状态与连接管理 | 163 SMTP/IMAP、凭据控制面、连接健康 | 渠道不同但能力骨架对应；企业 OAuth 仍是后续连接器 |
| WhatsApp | `/wa-connector/account`、`pair/start`、`pair/{id}`、`account/{id}/disconnect` | 配对、状态、断开 | Readywork 已有 WhatsApp webhook、上下文校验和 SLA channel，但未证明真实账号配对已上线 | 部分完成 |
| 通知 | `/api/notifications`、`/{id}/read`、`/read-all` | 过滤、单条已读、全部已读 | 持久化通知 API、对象深链、单条/批量已读 | 已对齐且审计更严格 |
| 实时刷新 | `/api/events` | SSE，事件族 `pos/outbox/messages/notifications` | Readywork `/api/events?stream=1` 支持租户隔离、游标重放、断线恢复和 reset；首页、PO、沟通草稿、通知与 PO Chat 已统一订阅，低频轮询仅作断线兜底 | 核心纵切已对齐；其余低频页面按业务价值逐步接入 |
| PO 列表/详情 | `/api/po`、`/po/{id}` | GET、POST、PATCH、DELETE；详情 Actions 为 Edit PO / Duplicate / Download PDF / Print / Cancel PO | 采购工作台/context/execution；Duplicate 已使用版本、权限、幂等和单事务创建独立 Draft；其余 Actions 尚未形成同等真实纵切 | 部分对齐；Readywork 不应物理删除采购事实或允许客户端覆盖阶段 |
| PO 跟进 | `/api/po/{id}/follow-up-now` | POST 立即跟进 | `queue_followup` 先生成持久化草稿，人工批准后才进 Outbox | Readywork 更符合人在回路要求 |
| 自动跟进策略 | `/api/po/follow-up-config` | GET、PUT `{ autoSend }` | Advanced SLA 版本化 auto-send allowlist + kill switch → message draft → 原子 Outbox；仍需身份、权限与连接器门禁 | 产品能力与三档鉴权浏览器验收已对应；正式库尚无可运行 profile |
| PO 聊天 | `/api/po/chat` | multipart：message、history、可选 file | Readywork 已提供同形 GET/POST 合同、SQLite 会话与消息历史、附件安全/解析门禁、模型分流、幂等与审计 | 已对齐且安全边界更严格 |
| 邮件草稿/Outbox | `/api/outbox`、`/{id}`、`approve`、`cancel`、`retry`、PATCH content | 列表、详情、编辑、批准、取消、重试 | 持久化 message drafts + Outbox + 编辑/批准/丢弃 + 真实连接器回执 | 已覆盖，Readywork 具名身份和版本门禁更强 |
| 供应商 | `/api/suppliers`、`/{id}` | CRUD | Odoo 同步、手工登记、主数据、绩效快照、关联 PO | 核心覆盖；删除应改为停用/归档 |
| SLA | `/api/sla-rules`、`/{id}` | CRUD | 基础 SLA 与独立 Advanced SLA 均有版本化草稿、双权限发布/退役、评估事件；基础规则显式区分自然小时与租户工作日 | 基础 SLA 公开桌面骨架与三档鉴权浏览器验收已完成；正式策略尚未发布 |
| Lead time | `/api/po/lead-times`、`/{id}` | CRUD | Migration 43 已建立租户隔离的供应商-物料标准制造交期；同形 GET/POST/PATCH/DELETE 合同绑定真实供应商 ID、审核后的 Local/Import 路线、物料编码/名称/默认匹配，并由 PO 风险与 SLA 冻结模板版本证据 | Lead Time 纵切已对齐且审计更严；Advanced SLA 的里程碑/合规/清关依赖已使用真实规则选择、悬空引用清理与后端全图循环门禁 |
| 配置 | 前端可见邮件、WhatsApp、国家、工作日、时区、日期格式和 auto-send 开关 | 连接/断开、偏好配置 | Readywork 已有连接器、身份、部署、readiness、安全事件，以及租户级国家/工作日/时区/日期格式 GET/PUT 合同 | 桌面 Web 已按 General Settings / Agent Setup / Advanced Governance 对齐，偏好、权限、版本、审计、日期消费与 SLA 日历均已接通；未有后端合同的节假日不显示假开关 |

## 2. Advanced SLA 的 9 个规则域

公开静态包可验证以下规则域和表单字段族。固定样例行是演示数据，只保留 schema 语义：

1. **Production / Service Milestones**：供应商、物料/服务、里程碑序号、阻塞关系、标准时长、更新频率、开始/完成证据、供应商联系人角色。
2. **Communication and Escalation Rules**：阶段、事件类型、首次响应 SLA、两次提醒、经理升级、渠道、供应商 L1–L3、各提醒风险等级。
3. **Payment Term Rules**：付款条件、触发事件、准备时长、完成 SLA、阻塞阶段、所需文件、责任职能、LC 细节。
4. **Logistics Planning Rules**：静态包明示为独立分区；不得与 Shipment 实例混为同一对象。
5. **Logistics Handover Requirements**：交接要求和证据模板。
6. **Transit Monitoring Rules**：在途节点、更新频率、异常与升级模板。
7. **Regulatory and Import Approval Rules**：法规/进口审批与依赖。
8. **Customs Clearance Rules**：清关节点、文件、阻塞和升级。
9. **Quality Inspection and GRN Rules**：质检与 GRN 规则、证据和责任链。

Readywork 已将这些运行事实之上的“模板/规则层”收口为 9 个版本化规则域的独立 Advanced SLA 产品面；具体验收边界见第 6 节。

## 3. 不应复制的行为

- 静态包包含 `/api/demo/seed-*` 与测试 PDF 下载入口。这些是演示/测试工具，不属于采购执行产品能力，不能进入 Readywork 生产导航或正式数据库。
- Readywork 的正式 API 启动路径保持真实空态，不自动创建 RFQ、PO、发票、供应商回信、异常或审批；`/api/events/inject`、聊天 `inject_event` 和员工页硬编码 PO 测试按钮均不属于 V1 公开合同并已移除。工作流调试继续使用隔离的 simulate / shadow 运行，不向业务账本注入伪造事件。
- 客户端可见 PO、供应商、SLA 的 DELETE 调用不证明服务端物理删除；Readywork 必须继续采用取消、停用、退役或追加纠正，保留审计与引用完整性。
- 客户端请求中未普遍显示 expectedVersion、idempotency key、审批身份或对象级权限，不代表这些门禁不存在。Readywork 现有版本、幂等、RBAC、Action Gateway 和连接器回读约束必须保留。
- `autoSend=true` 不能绕过具名采购身份、附件安全、供应商身份、SLA 发布、风险阈值和紧急停止开关。
- 不使用 Navisight 静态包里的 ACME、固定 PO、供应商、KPI 或规则样例填充 Readywork 正式数据。

## 4. 后端组合建议

| 域 | 推荐复用 | 需要新增 |
|---|---|---|
| 五阶段/通信 SLA | 现有 `procurement_sla_policies/evaluations/events` | 规则域 discriminator、适用对象范围、版本化 CSV import batch |
| 生产/服务里程碑 | Production Progress、Twin evidence 与 Migration 43 Material Lead Times | 交期模板、里程碑依赖字段、真实规则选择和循环门禁已完成；正式业务仍需供应商提供开始/完成证据后验证服务里程碑运行语义 |
| 物流/在途/清关 | Shipment、Transport Event、Import Document Policy | Planning/Handover/Transit/Regulatory/Customs 五类规则模板 |
| 质检/GRN | Receipt、GRN、Import document gate | Quality inspection 模板和 GRN 责任链规则 |
| 自动发送 | message drafts、Outbox、SLA automation、Temporal | 租户级版本化 auto-send policy、风险/渠道/阶段白名单、kill switch、预演和审计 |
| 实时刷新 | `/api/events`、Temporal、通知派生 | 核心页面已统一订阅；仅剩低频页面按需接入 |

## 5. 完成证据

Advanced SLA 只有同时满足以下条件才能计为完成：

- 独立导航和页面，9 个规则域均有真实 API 和持久化 schema。
- 手工与 CSV 导入使用同一验证器；导入先预览 diff，批准后单事务发布。
- 自动发送默认关闭；启用必须双权限审批、具名身份、已发布规则、渠道健康、kill switch 和审计。
- 规则变更能够预览受影响 PO，不反向篡改不可变业务事实。
- 刷新/重启后规则、导入批次、审批和执行结果一致。
- 正常、空、错误、无权限、连接器未就绪和自动发送暂停状态均通过浏览器验收。

## 6. Readywork Advanced SLA Task 5 工程证据

- 路由与持久化：`GET /api/procurement/advanced-sla`、profiles create/update/publish/retire、`PUT /api/procurement/advanced-sla/runtime-control`、imports preview/apply 均读写 `procurement_advanced_sla_profiles/profile_events/runtime_controls/runtime_events/import_batches`，所有读写保留 `tenant_id` 谓词、乐观版本与追加审计。CSV 待定预览显示并在 apply 时核对精确 batch/profile/candidate 版本和 PO 影响，不回退到 root draft impact。
- 迁移规则：已记录旧 migration 38 但缺 `profile_version` 的数据库，runtime control 从同 tenant 持久化 profile 重建；runtime event 仅接受内嵌 `profileVersion` 或同 tenant/profile 不可变发布事件作为版本证据，无证据行保留 `NULL/legacy_unknown`。旧库的缺列检查、加列与回填整体由 `BEGIN IMMEDIATE` 串行并在锁内重检；普通迁移同样在锁后重检 version/name。两个进程分别共享全新临时 SQLite 与已记录 v38 的旧临时 SQLite 的回归均通过。
- 验证：定向 API/automation/message-draft/Outbox `39/39`、Console `23/23`、Persistence `9/9`、全量 `491/491`；`pnpm typecheck` 和 Console production build 均 exit 0。验收只变更 `:memory:`/临时 SQLite 并使用 fake/local connector，未变更正式 SQLite，未调用 Odoo/Email/WhatsApp，未重启服务。
- 浏览器验收：2026-08-31 已在有效 HttpOnly 会话中打开独立 Advanced SLA 页面。正式库没有 profile 时如实显示“未发布 / 无草稿 / 未启用”、26 张活跃 PO、0 张匹配 PO、空事件和空 CSV 历史；创建、发布、退役和自动发送均保持禁用或等待真实配置，没有为了展示九域伪造规则。导航写入 `section=advanced-sla`，刷新可恢复同页。写动作、九域非空态和自动发送仍由隔离数据库测试证明，不在正式库制造样例。
- 九域依赖合同：Production / Service Milestones、Regulatory / Import Approval 和 Customs Clearance 的依赖字段现在从当前草稿真实规则生成选择器，删除规则同步清理草稿引用；服务端规范化器在 JSON 与 CSV 两条入口统一拒绝缺失、自依赖和任意长度循环。正式空库仍不制造规则，非空选择器由隔离测试证明。

## 7. Readywork 租户区域偏好合同证据

- Migration 39 持久化 `countryCode / workingDays / timeZone / dateFormat`；`GET/PUT /api/procurement/tenant-preferences` 强制会话、租户隔离、配置权限、严格字段校验、`expectedVersion` 乐观锁和追加审计。
- Console 根部使用单一 `ProcurementTenantPreferencesProvider` 读取真实 API。配置保存响应会即时广播到采购总览、PO、采购需求、RFQ、供应商、AP、路线、风险、通知、沟通草稿、SLA、运行/安全/部署/身份页及根工作区；刷新后重新从 SQLite 读取。
- `YYYY-MM-DD`、`DD/MM/YYYY`、`MM/DD/YYYY` 与 IANA 时区通过同一纯格式工具实现；date-only 字段不会因 UTC 解析漂移。风险日期范围和 PO Intake 默认下单日按租户日历日期计算，不使用浏览器本地时区猜测。
- 定向边界测试 `6/6`、Console TypeScript、全仓 TypeScript、ESLint（0 error / 0 warning）、Next.js 16.3.3 production build 与全量 `498/498` 均通过。
- Business API 已安全重启并加载当前代码；正式 `data/readywork.sqlite` 已记录 `39|procurement-tenant-preferences` 且两张偏好/事件表存在。4173 health 为 200，匿名偏好读取真实返回 401；平台刷新后显示“登录已过期，请重新登录”，浏览器 error/warn 日志为 0。
- 基础 SLA 规则新增显式 `calendarMode`：旧规则缺字段时确定性回退 `elapsed_hours`，不会因租户配置升级而静默改变期限；只有选择 `tenant_working_days` 的规则才读取 `workingDays / timeZone`。
- 工作日模式按租户本地工作日期中的墙上时钟小时累计，支持正负偏移、预警、宽限和跟进间隔，跳过非工作日；UTC 仍是唯一落库时间。每次评估的 `evidence_json/fingerprint` 冻结 `calendarMode / timeZone / workingDays / preferenceVersion / inheritedDefault`，发布事件另保留发布时日历快照，偏好变更后的重算会形成新的不可变评估事件。
- SLA Web 草稿表已提供“自然小时 / 租户工作日”选择、当前租户日历说明和评估证据展开；算法与 API 定向测试覆盖上海/纽约、周末、DST gap/overlap、正负偏移、默认兼容、非法模式、偏好版本重算和 SQLite 审计。2026-08-31 鉴权浏览器已验证正式 v2 草稿、5 条阶段规则、26 张影响 PO、24 张计时证据就绪、2 张缺期限证据；未获业务授权前没有点击发布，也没有启动正式 SLA 时钟。

## 8. Readywork Web 鉴权与会话恢复合同

- Readywork 现在具有独立登录门，未认证时不会挂载采购业务页面。`GET /api/auth/config` 只公开认证模式是否可用；`POST /api/auth/login` 在显式非生产演示模式下校验 scrypt 哈希账户并设置 HttpOnly/SameSite Cookie，响应不包含签名 token；`GET /api/auth/me` 返回当前账户与过期时间；`POST /api/auth/logout` 清除 Cookie。
- API 客户端不使用 localStorage 保存会话。任意非 auth 路由返回 401 时，应用根鉴权门立即接管；重新登录前不读取、审批或执行采购动作。只启用本地账户不再产生匿名管理员，生产环境无论变量为何值都拒绝内置演示账户。
- API 端到端探针已覆盖登录、Cookie、业务面 `/api/auth/me`、控制面 `/api/editor/workflows`、退出与退出后 401；流程图入口复用同一控制面，并将真实历史运行与 NodeRun 状态叠加到节点、路径和 MiniMap；SSE 另覆盖四类事件、租户隔离、历史重放与在线续传。2026-08-31 在现有有效 HttpOnly 会话中已打开“采购流程编排”，验证 Editor、模拟/影子/审批/自动四种运行入口，以及 Temporal、AI Runtime、Connector 状态条；未触发任何运行或发布。

## 10. Readywork 普通页面深链与刷新恢复

- 旧实现只把 `orders` 写入 URL，其余页面仅写浏览器 history state；直接打开 `?section=local-procurement` 会错误回到 Overview，无法形成可分享、可刷新验收的逐页入口。
- 2026-08-31 已将所有非首页业务 section 写入 query string，并让有效 URL section 优先于旧 history state；非法值继续 fail closed 到旧 history 或 Overview。
- 定向测试覆盖所有生产 section、退役页面重定向、未知值、URL 优先级与 fallback；鉴权浏览器已验证 `local-procurement → suppliers → import-procurement → advanced-sla → employees` 的 URL 更新，Local 与 Suppliers 刷新后仍恢复同页。

## 9. Readywork Material Lead Times 合同证据

- Migration 43 持久化 `procurement_material_lead_times` 与追加式 `procurement_material_lead_time_events`；活跃匹配以 `tenant_id + supplier_id + procurement_route + match_key` 唯一，DELETE 只转为 `retired`，不物理删除历史。
- `GET/POST /api/po/lead-times` 与 `PATCH/DELETE /api/po/lead-times/:id` 要求会话、租户隔离和 RBAC；写入只接受严格白名单字段、当前租户真实供应商 ID、显式 Local/Import 路线、变更依据与 `expected_version`。名称快照由供应商主数据生成，不根据供应商名称猜身份或路线。
- 运行时匹配顺序为“供应商 + 路线 + 物料编码”→“物料名称”→“供应商/路线默认值”；未分类路线不匹配。PO 组合风险在要求日期早于标准制造周期时产生 `manufacturing_lead_time_shortfall`，冻结 template ID/version、匹配方式、PO 行、可用天数与缺口天数；SLA evaluation evidence 复用同一证据。
- Suppliers 已纳入 `Material Lead Times (SLA)` 面板，与 Navisight 公开 Suppliers 页的主数据表和物料交期区保持同一桌面信息架构。交期区按七列语义展示 Supplier、Material、Item Code、Route、Lead Time、Remarks、Actions，并接通真实供应商下拉、加载/空/错误态、创建、编辑、版本冲突、退役与审计时间线。正式 SQLite 不会在无真实制造周期依据时插入样例行。

## 11. Readywork Configuration 三通道结论合同

- 首屏结论不读取前端 Mock，而是从现有 Connector 及加密凭据 API 派生 Email、WhatsApp Business 和 ERP/Odoo 状态。
- “已验证”的必要条件为运行健康、凭据完整、外部测试通过且当前凭据仍为 connected；任一条件缺失时必须回落到待测试、未配置、需修复、已停用或不可用。
- 正式库当前冻结为 Email=已验证、ERP/Odoo=已验证、WhatsApp=未配置。面板只提供到同一 Connector 目录的配置深链，不另建第二套状态或写入路径。
- 当前 V1 产品验收只包含桌面 Web（1280×720、1440×900、1920×1080）。手机端信息架构、导航和交互均后置，不进入当前端到端验收。

## 12. Readywork 基础 SLA 公开桌面合同

- Navisight 公开静态包的 `function r6()` 明确给出 SLA 页头、Add New Rule、搜索、Applies To / Status 筛选、七列规则表和 `Showing X of Y entries`；规则表最小宽度为 1040px。Readywork 以此作为桌面信息架构合同，不复制公开包中的演示业务行。
- Readywork 主表读取正式 v2 草稿的 5 条规则，支持真实搜索和状态 / 适用对象筛选；新增、复制、移除、保存继续复用版本化草稿 API、权限、乐观锁、幂等和追加审计。
- 发布影响、自动检查、评估、退役与运行证据保留在 `Policy Governance & Runtime` 渐进披露层；这部分能力没有为了表格视觉对齐被删除，也不会把未发布草稿伪装为 Active。
- 1280×720、1440×900、1920×1080 已完成登录态验收：页面级无横向溢出、无业务告警、无 Next 错误覆盖，干净标签 Console 0 error；1280 仅表格内部横向滚动。
- 正式 SQLite 保持 `draft=1 / published=0 / retired=0`、v2 规则 5、评估 0、自动运行 0。当前只完成基础 SLA 的桌面 Web 产品面，尚未获得正式发布授权，因此 SLA 发布门槛和 V1 readiness 均未关闭；手机端全部延期。

## 13. Readywork SLA 规则编辑合同

- Navisight 公开 `function r6()` 的操作列由 Edit 与 More actions 组成，Add / Edit 打开弹窗，More 菜单包含编辑、复制和删除。Readywork 已采用相同桌面骨架，但将删除语义收紧为版本化草稿变更。
- 有现存草稿时，Add / Edit / Duplicate / Remove 只改变未保存的 `draftRules`，页面持续显示 `Unsaved changes`，只有显式保存成功才写 SQLite；无草稿时通过 `POST /api/procurement/sla/policies` 创建包含完整规则集的新版本草稿。
- 已发布规则的删除请求不会调用物理删除；Web 创建一份不含该规则的 removal draft，旧正式策略持续生效，直到新草稿经过独立批准和发布。取消弹窗或确认框不发请求。
- 三档桌面弹窗和菜单已完成只读浏览器验收；正式 v2 草稿仍是 5 条规则，策略事件、评估、自动运行和 Outbox 均未变化。完整回归为 `570/570`，生产构建通过。

## 14. Readywork Risk Dashboard 高风险 PO 公开桌面合同

- Navisight 公开静态包可确认 Risk Dashboard 的桌面顺序为：五项 KPI、风险分布 / 分解 / 供应商三栏、账龄 / 产品 / 趋势三栏、高风险 PO 明细和风险口径说明。Readywork 以此作为桌面信息架构合同，不复制 ACME、官网固定 PO 或美元演示金额。
- 高风险表的九列必须读取同一不可变快照中的 PO、供应商、风险等级 / 评分、因子证据、RIHD、币种金额和下一步；快照缺字段必须显示空缺，不能拿当前组合伪造历史。
- 创建新快照继续是显式、受 `operate` 权限保护且按 source watermark 幂等的写动作；页面打开、表内滚动、PO 深链和返回都是只读。CSV 与可视明细使用同一快照字段合同。
- 1280×720、1440×900、1920×1080 已完成登录态实页验收；页面均无水平溢出、1280 只在表格容器内滚动，浏览器日志无 error / warning。验收未创建新快照或任何外部副作用。
- 当前合同只覆盖桌面 Web；手机表格、抽屉和底部操作栏延期。该页结构完成不等于真实采购五阶段、SLA、路线与最终 GRN 发布门槛已关闭。

## 15. Readywork Advanced SLA 公开桌面合同

- Navisight 公开应用静态包确认 Advanced SLA 为左侧 section 导航 + 右侧当前领域工作区，工具条包含 Search rules、Status、Template、Upload CSV、Add Rule，数据区包含 Rules、Validation Results、Upload History、Version History 四页签。Readywork 采用同一桌面骨架，不复制公开包的业务样例。
- 九域、规则参数、profile 草稿 / 发布 / 退役、乐观锁、依赖循环门禁、auto-send allowlist、kill switch、精确 PO impact、CSV preview / apply、RBAC 和追加审计继续由现有真实 API / SQLite 合同提供。视觉重排没有新建第二套前端状态或绕过外部副作用门禁。
- Rules、Validation、Upload History 与 Version History 只显示真实 profile、客户端 / 服务端验证、持久化导入和事件。正式库没有 Advanced SLA profile 时，9 个领域计数均为 0，创建 / 上传 / 发布动作按权限与草稿事实禁用或等待用户显式操作。
- 三档登录态桌面验收均无页面级水平溢出或浏览器错误。本轮没有创建正式 profile、上传 CSV、发布策略、切换 kill switch、生成消息、发送邮件或写 Odoo；手机端全部延期。

## 16. Readywork 公开 Product 桌面 Web 合同

- `/product` 的 Hero 次 CTA 只定位公开页 `#solution`；全宽 64px sticky 顶栏与 80px scroll margin 保证所有页内目标不被遮挡。Hero 使用 80px 视觉标题；Problem、Gap、Solution 与 How it works 使用 1360px 主容器。Problem 使用“ERP → 虚线分流 → Email / WhatsApp / WeChat / Phone calls / Spreadsheets”五通道拓扑，Gap 使用 2×2 的四条逾期前信号。
- How it works 必须保留五个编号圆点、阶段连接线和下方桌面双栏：左侧说明 SLA、供应商跟进和进口单证 / GRN 核验，右侧使用公开五阶段时间线。该公开说明是产品能力合同，不等于当前租户已发布 SLA、已配置 WhatsApp 或已完成最终 GRN。
- Risk visibility 使用 1360px 标题区与 1160px 居中产品图；Customer value 使用 1360×495px 双面板转换卡，并在下方保留 1160px KPI / Local / Import 公开产品图。FAQ 七项默认收起，答案按当前部署事实收紧。
- Demo 使用 1360px 桌面双栏与真实表单卡。成功态只有在 `/api/public/demo-requests` 完成严格校验、幂等与 SQLite / 审计事务后出现；页面不得复制 Navisight 公司的地址、电话、认证、回复时间或法律完成状态作为 Readywork / 当前部署事实。
- 这些公开样例不写入工作台数据，不声称当前租户已连接 WhatsApp / WeChat，也不伪造第三方认证。Privacy / Terms 现有独立公开路由，但明确是 Pre-release disclosure；运营主体、正式联系人、保留期、处理商、管辖和商用合同仍不能冒充为已获法律批准。
- Demo 申请继续走真实 API、幂等键、SQLite 单事务和追加审计，不自动发邮件、写 CRM / Odoo 或启动采购流程。
- 验收范围只有 1280×720、1440×900、1920×1080 桌面 Web。三档均验证顶栏 sticky、锚点偏移、五通道完整和页面无水平溢出；全仓测试 `578/578`、Console TypeScript、ESLint 和 Next.js 16.3.3 production build 通过。手机信息架构、导航、抽屉、底部操作和小屏重排全部延期。

## 17. Readywork Overview 桌面 Web 合同

- Overview 的六项 KPI、采购订单表、AI Procurement Summary 和 Local / Import 风险概览继续读取同一真实采购组合与持久化快照；本次桌面重排不改变 API、SQLite、风险口径或 PO 下钻动作。
- 1280×720 使用 3×2 KPI，1440×900 与 1920×1080 使用六张 KPI 单行。宽桌面继续在可用宽度满足时并排显示采购订单表与 318px AI 摘要，避免 KPI 额外占一行把核心执行区推离首屏。
- KPI 趋势读取 `/api/procurement/risk-dashboard` 的 `freshness`：`stale / missing` 时历史序列末尾追加当前组合 KPI，`current` 时不得重复追加；趋势百分比以最终可见序列的前一项与当前项计算。日期浮层必须并列展示持久化历史快照、当前 PO 事实水位与风险评估时间，不能把过期快照冒充实时值。
- 1920×1080 的 Local、Import 与行动卡使用 `1fr / 1fr / 318px` 三列，实页约为 `624 / 624 / 318px`；行动卡读取正式 `unclassifiedRoute` 并只应用 `route=unclassified` 过滤，不确认路线、不写 SQLite。1280×720 与 1440×900 可隐藏该重复行动卡，保留真实未分类告警。
- 当前合同仅定义桌面 Web，不新增手机导航、移动 KPI、抽屉、底部操作栏、触屏手势或小屏业务流程。

## 18. Readywork Employee Pack 流程图桌面深链合同

- 采购流程编排入口使用 `section=employees&view=developer`。`view=developer` 是显式、可分享、可刷新恢复的开发者视图选择；普通 `section=employees`、缺失或未知 `view` 不得绕过当前 Employee Pack 的业务 / 开发者页面所有权。
- 打开与刷新只读取 Employee Pack Manifest、工作流草稿、版本、运行、Runtime 和 Connector 状态。模拟、影子、审批运行、自动运行、发布和蓝图导入仍是各自独立的明确写动作，不因页面恢复自动触发。
- 离开开发者页会清理 `view` 并恢复业务模式。当前合同仅覆盖桌面 Web，不定义手机画布、移动节点库、触控连线或底部发布操作栏。

## 19. Readywork 全局桌面应用壳合同

- 全局侧栏复用 Navisight 当前公开应用的桌面几何：248px 展开宽度、12px 外留白、224px 内卡、24px 圆角、68px 品牌头，以及 36.25px 导航密度。折叠态为 76px 外壳与 52px 内卡。
- 应用根节点只裁剪 x 轴，不得把 `overflow-x-hidden` 重新引入根壳。页面滚动时侧栏保持 sticky，收起与展开均不随文档上移。
- 3001 开发环境不得让框架开发徽标覆盖产品操作；Next.js 开发指示器关闭。该配置只清理本地开发表面，不影响鉴权、真实 API、SQLite、审计、邮件或 Odoo。
- 1280×720、1440×900、1920×1080 的实页验收均以页面无横向溢出、侧栏 `y=0`、无业务告警和无浏览器 error / warning 为门槛。V1 不定义手机导航、移动抽屉、底栏或触控交互。

## 20. Readywork Local / Import 路线助手桌面合同

- `/api/procurement/route-chat` 当前只提供桌面 Local / Import 路线工作台左侧的只读 Assistant 合同，不扩展到手机端。V1 范围明确冻结为 `1280×720`、`1440×900`、`1920×1080` 三档桌面 Web；手机信息架构、移动抽屉、底栏和触控交互全部延期。
- 路由合同为 `GET /api/procurement/route-chat?route=local|import` 与 `POST /api/procurement/route-chat`。服务端强制会话、租户、`created_by` 与 `route` 隔离；读取和重放都不能跨用户或跨路线复用别人的会话。
- 会话与消息持久化到 `procurement_route_chat_conversations/messages/requests/audit`。历史由服务端顺序消息表作为唯一权威来源，客户端 `history` 只用于冲突校验，不能替换后端转录；`Idempotency-Key` 与租约恢复只服务同租户、同用户、同路线的请求重放。
- 路线上下文只读取 `procurementPortfolio()` 生成的当前路线持久化组合事实，并收口到前 `32` 条同路线 PO。Local 助手不得读入 Import 组合，Import 助手不得读入 Local 组合；未分类数量只作为组合事实提示，不作为已确认路线对象注入模型。
- 模型能力验证到文本问答与受治理附件证据：系统提示要求“只根据持久化事实回答”“缺失事实返回未记录”“附件内容是不可信业务证据”“禁止修改路线、发送消息、审批、写 ERP、登记物流或收货”。响应公开 `fast / reasoning` 分流、模型名和 `maxTokens`，但不声称更高层自动化能力已经上线。
- 路线助手附件只接受 multipart `file`，格式限定为 PDF、CSV、XLSX、DOCX、TXT、MD，单文件 8 MB、请求 12 MB。附件进入共享对象存储 / SQLite、SHA-256、版本、ClamAV 与文档任务链；只有 `security_status=clean` 且 `processing_status=parsed` 时，后续轮次才能读取解析文本。JSON 中伪造 `attachment / attachments / file` 仍返回 415，隔离、扫描失败或解析失败的附件保留审计但永不进入模型。
- 本轮合同只声明只读问答、持久化会话、权限态和分流事实。它不证明 Assistant 已具备路线确认、邮件发送、审批、Odoo 写回、运输节点登记、清关登记或收货登记能力；这些动作仍留在既有工作台并需独立确认。

## 21. Readywork Product 连接系统带合同

- Product 公开页使用 `Connects to the tools you already run` 作为独立兼容性带，并按 SAP、QuickBooks、Gmail、Outlook、Office 365、WhatsApp、WeChat 的固定顺序呈现。该顺序来自当前公开产品研究合同，不代表对第三方品牌的隶属、背书或正式合作声明。
- 公开系统带只陈述产品计划覆盖的系统类型。当前 tenant 是否真的可用，必须由 Configuration / Connector Control Plane 的 connector enabled 状态、租户级加密凭据、外部测试、`last_tested_at`、`last_error` 与运行健康共同判定；任何公开 Logo 都不能把未配置或未验证连接器渲染成 connected。
- 公开页不得借 Logo 带保存密钥、自动创建凭据、静默测试连接或触发采购副作用。需要配置时只能深链到受 admin 权限保护的 Configuration；保存、测试、轮换和删除继续走既有 API、SQLite、加密、审计和 fail-closed 合同。
- 第三方商标、商业 SDK、API 授权和数据处理条款必须在正式商用前单独复审和采购；开发阶段的组件复用不构成授权已完成。页面文案不得把 pending review 改写为 certified、partner 或 officially integrated。
- 当前合同只覆盖 1280×720、1440×900、1920×1080 桌面 Web，不定义手机轮播、移动导航、抽屉、底栏或触控交互。

## 22. Readywork Local / Import 公开细节与租户 ERP 合同

- Local / Import 的 Assistant 欢迎区、五条能力、四个快捷问题、控制顺序、单行输入和关闭后的浮动恢复入口采用当前 Navisight 公开桌面信息架构；Readywork 的文案按 Local / Import 真实路线分别表达，不复制公开 bundle 的 96 / 156 张演示 PO。
- Filters、RIHD 日期范围、斑马纹与编号分页只消费真实采购组合；当前正式租户 Local / Import 均为 0，26 张活跃 PO 仍保持未分类，页面不得为了表格完整填入样例行。
- 公开页面的附件入口已由真实 multipart 合同支撑，而不是装饰按钮。Web 展示待发送、等待扫描 / 解析、已扫描并解析、阻断和解析重试状态；文件、会话、消息引用、哈希和审计均持久化。模型只在后续轮次读取已通过安全与解析门禁的文本，不把刚上传或失败附件伪装成已理解。
- Odoo 业务读取和同步必须由当前会话 tenant 的已验证 Connector 凭据解析；启动期固定租户单例、跨租户 fallback、失效缓存和敏感 binding 日志均不允许。Outbox 在租约领取后再次解析当前凭据，外呼回执只冻结非敏感 credential identity。
- 本合同只冻结 1280×720、1440×900、1920×1080 桌面 Web；不增加手机端、移动导航、抽屉、底栏、触控手势或小屏业务流。

## 23. Navisight PO Detail Actions 最新公开合同

- 当前公开 PO 详情页头的 `Actions` 菜单为 `180px`，固定顺序是 Edit PO、Duplicate、Download PDF、Print、Cancel PO；编辑与复制共用 `560px` 弹窗。Readywork 已完成 Duplicate 的真实纵切，但尚不能把其余入口标记为已完成。
- 编辑表单公开字段包括 Supplier Name / Email、Contact、RIHD、Item、Local / Import route、Direct / Indirect material type、Stage、Status、Lead Time 和 Transit Time；复制额外要求唯一 PO Number。Readywork 的五阶段必须继续由 Confirmation、Production Progress、Shipment、Receipt / GRN 等事实投影，任何 Edit PO 设计都不得让客户端直接覆盖 Stage / Status。
- Download PDF 与 Print 在公开客户端中实际共用浏览器打印 HTML，不是独立服务端 PDF 合同。Readywork 对齐时应从同一版本化 PO Context 生成确定性打印投影，显示数据水位 / 版本并避免把当前浏览器拼接值伪装成签署原件。
- Cancel PO 的公开客户端调用 DELETE，并显示“永久删除 PO、行、文档和历史”。Readywork 只能吸收红色危险入口和二次确认交互；后端必须采用追加式 `purchase_order.cancelled` 事实、期望版本、幂等键、原因、权限和审计，保留行、附件、沟通、阶段和外部映射。已发运、已收货、已有发票或结果不确定的 ERP 写入必须阻断自动取消并转人工处置。
- 待实现组件选择优先使用 MIT 的 `@radix-ui/react-dropdown-menu` 与 `@radix-ui/react-dialog`，分别复刻公开 Actions 菜单的键盘 / 焦点语义和 560px 模态层；当前 Console 没有这两个依赖，只有用户确认该纵切后才加入。公开包的 Download PDF / Print 实际共用浏览器打印 HTML，因此第一版应复用确定性打印视图而不是引入 10–20 MB 级 PDF 生成依赖；若后续验收要求直接下载 PDF 字节，再评估 MIT 的 `@react-pdf/renderer` 并嵌入可再分发中文字体。
