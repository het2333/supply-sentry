# Readywork × Navisight Clean-room 全量对齐设计规格

> 状态：用户已于 2026-09-02 批准；进入分片实施计划与 TDD 执行  
> 日期：2026-09-02  
> 决策：采用方案 A，在保留 Readywork 品牌、数据真实性和现有安全门禁的前提下，对齐 Navisight 登录后采购平台的信息架构、桌面页面骨架、密度、交互状态与业务流程。  
> 当前门禁：本规格获用户确认后才编写实施计划；本规格本身不授权修改生产代码、正式 SQLite、连接器、SLA、采购事实或外部系统。

## 1. 决策记录

### 1.1 已批准方向

本项目属于架构级改造。用户已批准方案 A：以 clean-room 方式重构 Readywork 的采购执行产品面，使其在登录后的桌面 Web 上与实测平台高度一致，同时保持 Readywork 自有品牌和更严格的真实业务、安全、权限、审计与外部副作用契约。

“对齐”在本规格中有五层含义：

1. **信息架构对齐**：采购侧栏只呈现十个固定一级入口，并保持固定顺序。
2. **页面骨架对齐**：页头、卡片、筛选、表格、双栏、页签、弹窗、菜单、空态和密度遵循实测结构。
3. **交互状态对齐**：按钮位置、动作顺序、筛选结果、选中态、键盘焦点、加载、空、错、无权限和冲突状态具有相同可理解性。
4. **业务流程对齐**：草稿审核、路线工作台、PO 六页签、风险、供应商、SLA、Advanced SLA、连接设置形成完整可操作流程。
5. **工程真实性增强**：所有业务数据和成功结果必须来自真实 API、SQLite、Temporal、Outbox、Odoo、Email/WhatsApp 回执和不可变审计，不能因为视觉对齐而降低 Readywork 的门禁。

### 1.2 选择方案 A 的原因

方案 A 能最大程度降低用户从参考平台迁移到 Readywork 的学习成本，并避免“页面看起来相似、行为却不可信”的半成品。Readywork 已具备大量真实后端能力，适合通过纵向分片重构产品面，而不是建立第二套演示前端或平行状态。

### 1.3 明确不采用的做法

- 不复制 Navisight 商标、Logo、公司文案、图片 URL、演示 PO、供应商、KPI、风险数字或规则样例。
- 不调用或复用 Navisight 私有 API、服务端代码、账户数据、HTML 业务数据或受保护资产。
- 不复制其可能存在的供应商映射错误、无会话 API 暴露、Demo Seed、物理删除采购事实或前端直接覆盖阶段/状态等行为。
- 不新建 mock-only 页面、静态 JSON 业务源、假定时器、localStorage 业务存储或“点击即成功”的装饰性集成。
- 不把开发者流程图、编排、运行控制台或平台治理入口放入采购业务侧栏。
- 不为验收向正式数据库注入样例行，也不修改现有正式采购事实。

## 2. 范围、非范围与完成定义

### 2.1 本次范围

- 登录后桌面采购平台的十项一级 IA。
- Overview、Notifications、Drafted Emails、Local、Import、Risk Dashboard、Suppliers、SLA、Advanced SLA、Configuration。
- PO Detail 的 Overview、Items、Supplier、Documents、History、Communication 六页签和五项 Actions。
- Readywork 品牌替换，包括公开 Product、登录、Privacy、Terms 和产品包命名中面向用户的 Navisight 泄露。
- 支撑上述页面的真实 API、SQLite migration、领域模型、Temporal/Outbox/Odoo/Email/WhatsApp 契约、权限、审计和测试。
- 1280×720、1440×900、1920×1080 三个桌面视口。

### 2.2 本次非范围

- 手机导航、移动抽屉、底部操作栏、触摸手势、原生 App 和小屏像素对齐。
- 对参考平台不可见、不可验证或专属于其内部实现的行为。
- 个人 WhatsApp Linked Devices 的模拟 QR、模拟配对码或非官方账号自动化。
- 自动修复 21 个现有安全事故、发布正式 SLA、猜测 Local/Import 路线或制造五阶段业务事实。
- 替换 Temporal、Outbox、Odoo、Connector Control Plane 或现有审计体系。
- 在规格审核前编写实施计划或修改生产代码。

### 2.3 100% 对齐的验收含义

“100%”只针对本规格冻结的、可验证的桌面产品合同，不声称复制未知内部实现。完成时必须同时满足：

- 十个一级入口的标签、顺序、页面所有权与深链精确一致。
- 本规格列出的页面区块、固定表格列、页签、菜单、弹窗和状态全部存在。
- 每个可见业务动作都有真实后端纵切；没有 mock、假成功或无持久化操作。
- 刷新、重启、并发、重放和版本冲突后，页面与权威数据一致。
- 正常、空、加载、错误、403、404、409、422、连接器未就绪、外部结果未知和 kill switch 状态可诚实呈现。
- 三个桌面视口无页面级水平溢出、操作遮挡或明显骨架偏差。
- Readywork 品牌检查通过，生产资源和用户文案不再依赖 Navisight 域名或商标资产。
- 正式 SQLite 在开发与验收中不注入 Demo 数据；副作用测试使用内存库、临时库、fake/local connector 或显式隔离环境。

## 3. Clean-room 与品牌边界

### 3.1 可吸收内容

- 通用的信息架构、页面分区、视觉层级、布局比例、表格密度、筛选顺序、页签顺序和动作命名。
- 用户可观察的工作流程，例如 Pending/All、Approve & Send、PO 六页签、五项 Actions、九个 Advanced SLA 域。
- 通用视觉语法，例如浅灰背景、白色卡片、蓝色主动作、状态色、12–16px 控件/卡片圆角和紧凑桌面表格。

### 3.2 必须自有的内容

- 品牌名称统一为 **Readywork**；产品名为 **Readywork Procurement Execution**。
- Logo、图标组合、插画、产品截图、营销图、FAQ、法律正文和公司描述使用 Readywork 自有资产与事实。
- 业务数据只来自当前租户的 Readywork 数据源。
- 风险算法、权限模型、审计、外部投递和连接器实现使用本规格定义的 Readywork 契约。

### 3.3 自动化品牌门禁

生产源码、静态资源和面向用户测试必须满足：

- 不从 `navisight.ai` 或其子域远程加载图片、Logo、字体、脚本或样式。
- `/product`、登录页、metadata、Privacy、Terms、Employee Pack 和导航不把 Navisight 作为产品名。
- 可以在内部 clean-room 证据文档和明确标注的测试描述中引用参考名称，但这些字符串不得进入生产渲染结果。
- 商标扫描与网络资源扫描作为发布门禁；发现生产路径引用即失败。

## 4. 用户与产品设计原则

### 一、用户真实心理

采购执行人员打开平台时最关心“哪张 PO 会出问题、我现在要做什么、动作会不会误发或误改 ERP”。他们不愿先理解底层工作流、连接器、规则引擎或治理术语，也不信任缺少证据和回执的 AI 结论。

### 二、用户目标

用户要在最短时间内完成四件事：识别风险、打开完整对象、执行下一步、确认系统已经真实保存或送达。管理员还要知道哪些连接尚未就绪、哪条策略正在生效、自动化如何被暂停。

### 三、用户阻力

- 一级导航过多、中文/英文混杂或同一能力出现多个入口。
- 表格列过密，核心判断被运输、证据和底层技术字段淹没。
- 点击动作后只出现绿色提示，却无法确认数据库、ERP 或消息通道是否成功。
- 页面把无权限、无数据、连接失败和未配置混成同一个空态。
- 规则表单要求手输内部 ID、JSON 或理解平台实现。
- 风险分数没有成分、证据覆盖率或模型版本。

### 四、产品策略

- 先给结论和下一步，再渐进披露证据与治理。
- 业务侧栏只保留十个用户目标，不展示开发者工具。
- 所有写动作先校验权限、对象版本、业务状态和连接器门禁，再显示可执行状态。
- 所有外部动作区分 `accepted/pending/succeeded/failed/unknown`，只有最终回执为成功时使用“已发送/已同步/已取消”。
- 默认保守：缺证据不是低风险，连接未知不是已连接，空库不是演示库。

### 五、页面结构

每个页面从上到下使用统一顺序：面包屑/标题与一句用途说明 → 最重要结论或 KPI → 主操作与筛选 → 主列表/主任务 → 次级证据或治理。高级配置、运行状态、证据详情和审计默认折叠或放在对应页签。

### 六、关键交互

- 每次点击立即显示进行中状态，并说明正在保存、验证、生成、排队还是等待外部回执。
- 有破坏性的取消、退役、断开和丢弃动作必须二次确认并要求原因。
- 409 后保留用户输入，重新读取权威版本，明确提示冲突字段。
- 外部结果未知时保留同一幂等键和恢复入口，不允许用户通过重复点击创建第二个动作。
- 对象深链、页签、筛选和返回来源可刷新恢复。

### 七、文案建议

- 主动作使用结果型文案：`Approve & Send`、`Save Changes`、`Generate PDF`、`Cancel Purchase Order`、`Validate CSV`、`Apply Valid Rows`。
- 诚实状态使用：`Waiting for connector receipt`、`No persisted rules in this section`、`You can view status; an administrator manages this connection`。
- 空态直接给最短路径：`No SLA rules match your filters.`；无草稿时提示创建真实草稿，不生成示例规则。
- 避免 `AI 智能分析系统`、`提交`、`确定`、`操作成功` 等无结果含义的泛化文案。

### 八、转化优化

本次登录后平台不设计付费墙。商业信任来自真实数据、可追溯证据、清晰回执和 Readywork 自有品牌；公开 Product 页面先展示可验证的结果类型与监督式执行边界，再引导真实 Demo 申请。

### 九、删减建议

- 从采购侧栏移除流程图、编排、工具与连接、组织、员工、任务、审批等平台级入口；保留独立管理深链。
- 从 Local/Import 主表移除运输事实、ETA、清关、单证和路线证据等扩展列，放入 PO 详情或次级抽屉。
- 从 SLA 首屏移除重型治理面板，折叠为 Policy Governance & Runtime。
- 从 Configuration 首屏移除连接器目录、凭据字段、事故列表和运行队列，收进 Advanced Governance。
- 从 Advanced SLA 移除要求用户编辑 JSON 的主流程，改为类型化表单和按域 CSV 模板。

## 5. 当前事实基线

本规格以 2026-09-02 的只读审计为基线：

- SQLite integrity 为 `ok`，已记录 migration 48。
- PO 共 32 张，活跃 26 张；Local 0、Import 0、未分类 26。
- 五阶段正式生产事实均为 0，完整闭环为 0。
- V1 readiness 为 `blocked · 6/11`。
- 阻断包括：缺少供应商可见的具名采购身份、无已发布正式 SLA、21 个未处置安全事故对应 64 条不可变原始事件、无真实 Local PO、无真实五阶段闭环与最终 GRN。

这些数值是当前部署事实，不是 UI 固定文案。规格实现后页面仍必须实时读取权威 API；不得把上述基线硬编码为产品数据。

## 6. 总体架构

### 6.1 单一纵向契约

每个页面能力沿同一方向贯通：

```text
Readywork Console
  → typed API client
  → Business API / Control API
  → domain validation + RBAC + object authorization
  → SQLite transaction / immutable event
  → Temporal / Outbox / Odoo / Email / WhatsApp（如需要）
  → receipt / projection / audit
  → SSE invalidation + authoritative reload
  → final UI state
```

前端不得自行推导业务成功、风险事实、路线、阶段、供应商映射或历史快照。后端响应必须返回足以重新渲染页面的权威对象身份、版本、动作状态、审计关联和外部回执摘要。

### 6.2 复用原则

- 复用现有采购工作台、PO context、message draft、Outbox、通知、路线、供应商、SLA、Advanced SLA、Temporal、Connector 和审计服务。
- 不建立第二套采购状态、第二套风险计算、第二套供应商身份或第二套消息发送路径。
- 页面筛选可以在客户端做即时交互，但导出、跨页统计和风险口径必须由服务端使用同一查询合同生成。
- 同一 PO 的列表、详情、PDF、打印、风险下钻和通信使用同一版本化 PO Context 投影。

### 6.3 安全与一致性不变量

- 所有读写都带当前会话 tenant 谓词；对象级授权在服务端复核。
- 所有可重试写动作要求 `Idempotency-Key`；更新要求 `expectedVersion`。
- 重要写动作在同一事务内保存业务事实、版本、幂等回执和审计事件。
- 不可变事实通过追加、取消、退役或纠正表达，不物理删除。
- 日志、遥测、审计和错误响应不包含密钥、完整邮件正文、无关联系人数据或未脱敏附件内容。
- 连接器领取任务后、实际外呼前再次解析当前租户当前版本凭据，避免使用撤销后的缓存。

### 6.4 开源组件、商业组件与 API 组合策略

本项目采用“能力优先、组合优先、权威边界不外包”的选型策略。成熟库负责表格、弹层、图表、日期、校验、文件渲染和协议适配；Readywork 自己保留租户、权限、业务状态机、SQLite 事实、版本、幂等、审计、风险模型和外部回执判定。组件能缩短实现时间，但不能成为第二套业务数据库。

| 能力 | 首选组合 | 许可/使用方式 | 决策与边界 |
|---|---|---|---|
| 紧凑 PO/供应商/规则表格 | TanStack Table v8；真实大数据量时增加 TanStack Virtual | MIT | 负责排序、列、分页、键盘和虚拟化；筛选、统计、导出与业务数据仍由 API 定义 |
| Actions、Dialog、Popover、Tooltip | Radix UI primitives + 本地 Tailwind primitives；允许采用 shadcn/ui 的 MIT 源码模式 | MIT | 首选补齐焦点陷阱、roving focus、Escape 和无障碍；样式与业务门禁仍由 Readywork 控制 |
| 风险图表 | Recharts，按 Risk Dashboard 路由动态加载 | MIT | 只渲染不可变快照；无两份真实快照时不画估算趋势，不引入第二套 visx |
| 日期范围与日历 | react-day-picker + date-fns；公共节假日继续复用 date-holidays 3.36.0 | MIT；date-holidays 为 ISC AND CC-BY-3.0 | 显示使用租户时区，落库使用 UTC/ISO；节假日来源与版本写入 SLA 证据 |
| 全局对象搜索 | cmdk + Readywork 权限化搜索 API | MIT | cmdk 只负责命令面板交互；搜索结果和动作权限由服务端返回 |
| HTML 邮件安全显示 | DOMPurify；默认仍为纯文本或受限 HTML | Apache-2.0/MPL-2.0 双许可 | 禁止脚本、外部跟踪和未授权远程图片；附件继续走扫描与授权下载 |
| 类型化 API/CSV 规则校验 | Zod v4 共享 schema；Advanced SLA v2 由同一 schema 生成表单和逐行错误 | MIT | schema 放在共享 core，JSON、手工表单、CSV 和 runtime 共用；不能只有客户端校验 |
| CSV | 复用现有 Papa Parse 5.5.4 做解析；服务端使用严格 RFC 4180 serializer | MIT | 禁止 `scope_json/parameters_json` 主流程；导出冻结水位、哈希和审计 |
| 服务端 PO PDF | `@react-pdf/renderer` + 可再分发的 Noto Sans CJK 字体子集 | MIT；Noto 字体 SIL OFL 1.1 | 服务端生成确定性 bytes；PDF.js 只做查看，不成为业务数据源；字体许可和 NOTICE 随制品保留 |
| PDF/图片/Office 证据阅读 | 复用 pdfjs-dist、ExcelJS、Mammoth、Tesseract；需要浏览器 PDF 组件时采用 react-pdf | Apache-2.0/MIT 等，逐包登记 | 预览只读已扫描对象；解析结果是证据候选，不直接覆盖 PO 事实 |
| 病毒扫描与复杂文档解析 | 继续 ClamAV 隔离服务；复杂格式需要时组合 Apache Tika | ClamAV GPLv2 独立服务；Tika Apache-2.0 | 记录引擎/签名版本；不得把 AGPL/GPL 浏览器代码无审查打入产品 bundle |
| Durable workflow | 继续 Temporal Server + TypeScript SDK/Worker | MIT；Temporal Cloud 为商业服务 | 不引入第二套 BPM 引擎；工作流重试不能改变业务幂等语义 |
| Odoo | 继续租户级 Readywork connector + Odoo 官方 API | Odoo Community LGPLv3；Enterprise 专有 | 不复制 Enterprise 代码；客户订阅、API 版本和写回权在商用前确认 |
| Email / WhatsApp | 继续 SMTP/IMAP 与官方 Meta WhatsApp Cloud API/Webhook；企业 OAuth 可组合 Gmail API/Microsoft Graph | 各 API 条款、配额、模板和数据处理约束 | 连接器回执是发送成功的唯一权威；不使用非官方个人 WhatsApp 自动化冒充生产能力 |
| 对象存储 | S3 API；可用云 S3 或已取得合适授权的兼容服务 | 云服务条款；新版 MinIO 涉及 AGPLv3/商业授权 | SQLite 保存引用、哈希和状态；商用前确认部署与网络服务义务 |
| 可观测性 | OpenTelemetry + Prometheus/Grafana；需要托管告警时可选 Sentry | OSS 基础；托管/Enterprise 另行采购 | 联系人、邮件、PDF、token 先脱敏；遥测不能存业务正文 |
| 运输地图 | 有真实经纬度和业务价值后采用 MapLibre + 合法瓦片服务 | BSD-3-Clause/MIT；瓦片另计许可/费用 | 当前 Local/Import 先用节点列表；没有坐标不画假路线 |

#### 商业组件与试用授权

- 用户允许为了开发速度使用商业组件或 API。实施期可以在供应商条款允许的本地/隔离评估环境中使用正式 trial/evaluation license，例如 AG Grid Enterprise、Tiptap Pro、Mapbox、Temporal Cloud、Sentry、商业对象存储或企业文档 SDK。
- 不能绕过授权、破解许可证、移除水印或把仅限评估的制品发布到生产。商业组件进入代码前必须同时提供可替换接口和本地功能开关；没有生产 entitlement 时，商用构建 fail closed 或使用已验证的 OSS fallback。
- 只有当首选 OSS 组合无法满足明确验收项时才引入商业替代。选择依据按顺序为：能力完整度、交付速度、安全/无障碍、可恢复性、总成本、可替换性。
- 商用上线前必须完成采购、许可证、API 条款、DPA/数据驻留、配额、字体/图标/瓦片再分发和 NOTICE 复核。开发完成不等于获得商用发布权。

#### 依赖与许可证账本

实施分片 1 必须创建 `docs/THIRD-PARTY-LICENSES.md`，每个新增或直接使用的组件记录：精确版本、SPDX、用途、直接/传递依赖、源码或供应商地址、trial 到期日、生产授权状态、账号/配额、数据是否离开租户环境、NOTICE 要求、fallback、负责人和商用放行结论。

所有新增依赖使用精确版本，不写 `latest` 或宽泛范围。现有 manifest 中的 `latest` 在对齐发布前固定为当前 lockfile 已验证版本；版本固定与功能修改分开验收，不借机升级框架。新增包必须通过许可证扫描、`pnpm audit`、lockfile diff、SSR/客户端 bundle、首屏体积、键盘/屏幕阅读器和生产构建验证。

## 7. 全局应用壳与十项 IA

### 7.1 固定一级导航

采购业务侧栏必须且只能按以下顺序显示：

1. Overview
2. Notifications
3. Drafted Emails
4. Local
5. Import
6. Risk Dashboard
7. Suppliers
8. SLA
9. Advanced SLA
10. Configuration

`Advanced SLA` 是一级入口，不得下沉。PO Detail 通过列表和对象深链进入，不增加一级导航。开发者能力保留现有深链与权限，但不进入采购业务侧栏。

### 7.2 稳定 section 与旧深链

规范 section 保持现有可复用 ID：`home`、`notifications`、`message-drafts`、`local-procurement`、`import-procurement`、`risk-dashboard`、`suppliers`、`sla`、`advanced-sla`、`settings`。旧中文或平台级入口继续按兼容表解析，但进入采购包时不渲染为一级项。

旧 `po-intake` 保留为 Configuration 中的受治理深链；`employees&view=developer` 等开发入口保留直接 URL 和原权限，不被采购侧栏暴露。

### 7.3 视觉令牌

- 字体：Inter Variable 或稳定的系统 sans-serif 回退。
- 页面背景：`#f8fafc`；主前景：`#0f172a`；主动作：`#2563eb`。
- 展开/收起侧栏：248px / 76px；外留白 12px；侧栏大容器圆角 24px。
- 内容水平留白 28px，垂直留白 24px；流式主内容，不设置页面级 1400–1720px 固定最大宽度。
- 主标题 26px、700、tracking `-0.025em`；副标题 13.5–14px。
- 控件圆角 12px，标准卡片 16px，大型聚合面板 24px；状态胶囊使用全圆角。
- 通用交互 150ms；侧栏 320ms、`cubic-bezier(.16,1,.3,1)`。
- 状态色固定：危险 `#ef4444`、警告 `#f59e0b`、交付风险 `#fbbf24`、正常 `#16a34a`、信息/主动作 `#2563eb`。

### 7.4 全局状态

- 会话检查完成前不挂载采购页面。
- 中途 401 统一回登录页；403 显示权限边界而不是“无数据”。
- SSE 负责核心对象失效通知，低频轮询仅作断线兜底。
- 页面保留最近一次成功读取时，后台刷新错误必须标注“显示的是上次成功数据”及水位时间。
- 全局搜索、通知和用户菜单不得遮挡页头或移动主内容。

## 8. 逐页差距矩阵

| 页面 | 当前可复用 | 必须补齐 | 数据真实性边界 |
|---|---|---|---|
| Overview | 真实工作台、KPI、路线概览、风险快照 | 统一英文 IA、密度与筛选；消除演示文案 | KPI 与趋势只读 API/快照，不硬编码 |
| Notifications | All/Unread、已读、SSE、版本锁 | 视觉密度、英文标题和细节 | 已读动作真实持久化；空态不造通知 |
| Drafted Emails | 双栏、Pending/All、批准、编辑、丢弃、Outbox | 编辑 `recipient`、渠道校验、文案对齐 | 只有 Outbox/连接器回执成功才显示已发送 |
| Local/Import | RouteChat、阶段、筛选、真实 PO、路线与执行动作 | 固定主表列、服务端导出、次级证据披露 | 不猜路线，不为 0 行填样例 |
| PO Detail | 六页签、context 聚合、Duplicate | Edit、Download PDF、Print、Cancel；页签字段完整化 | 阶段/状态只能由事实投影，不能前端覆盖 |
| Risk Dashboard | 真实快照、筛选、趋势、导出、下钻 | RiskModelV2 与证据覆盖 | 不复制演示分数；缺证据不是零风险 |
| Suppliers | 主数据、Odoo、绩效、交期、添加 | Supplier Profile、完整 Add/Edit/More | `supplierId` 是唯一关联键，不按名称猜测 |
| SLA | 草稿/发布/退役、评估、日历、审计 | 简洁七列表、Add/Edit 主字段、渐进治理 | 无已发布规则时真实空态 |
| Advanced SLA | 九域、profile、CSV preview/apply、kill switch | schema v2、共同元数据、按域模板、逐行验证与标准历史 | 手工/CSV/运行时使用同一 validator |
| Configuration | General Settings、连接摘要、治理能力 | Agent Setup 直接骨架、WhatsApp 诚实连接方式、自动发送风险说明 | 未连接/无权限/Cloud API 均不得伪装 QR 成功 |
| Product/Legal | 真实 Demo API、公开页面骨架 | Readywork 品牌、资产、文案和法律事实 | 不远程加载参考资产，不复制演示 KPI |

## 9. 页面与纵向契约

### 9.1 Overview

**骨架**：页头日期范围与筛选 → 六张 KPI → PO 表与右侧 AI Procurement Summary → Local / Import 风险概览。1920 宽屏使用六 KPI 单行和 `PO 表 + 318px Summary`；1440 保持六 KPI 单行；1280 使用 3×2 KPI，并允许主表与摘要上下排列。

**PO 表**至少呈现 PO Number、Supplier、Route、Material Type、Current Stage、RIHD、Risk、Next Action；金额只在币种明确时显示，不跨币种盲目求和。

**契约**：继续读取 procurement workbench 与 risk dashboard。趋势按风险快照 `freshness` 处理；`stale/missing` 可在持久化历史末尾追加当前实时 KPI，`current` 不重复追加。页面打开与筛选均为只读，不刷新风险快照、不确认路线、不发送消息。

**状态**：无活跃 PO 时显示真实起步路径；有未分类路线时给出进入路线核验的操作，不把未分类计入 Local 或 Import。

### 9.2 Notifications

**骨架**：页面标题 → All / Unread → Mark all read → 单列通知流。通知项固定显示严重度、标题、摘要、时间、未读点和对象深链。

**API**：复用现有列表、单条已读和批量已读端点；请求带 `expectedVersion`，批量操作返回更新数和权威未读计数。

**持久化与审计**：已读状态按用户与租户保存；后台投影通知和人工已读事件分开记录。打开对象为只读导航，不改变 PO 阶段。

**状态**：空态不出现手动刷新装饰按钮；SSE/兜底刷新在数据层工作。无权限不能渲染为“暂无通知”。

### 9.3 Drafted Emails

**骨架**：左侧 340–380px 队列，Pending / All；右侧显示待审状态、跟进类型、From/To、Subject、Body、决策依据、Approve & Send / Edit / Discard。队列项约 73px 两行密度。

**编辑契约**：现有 PATCH 扩展为：

```ts
type UpdateMessageDraftInput = {
  expectedVersion: number;
  recipient: string;
  subject: string;
  body: string;
  reason: string;
};
```

`recipient` 按 draft channel 校验：Email 使用规范化邮箱语法和拒绝占位域名规则；WhatsApp 使用 E.164 或连接器定义的规范化号码。编辑不能改变 tenant、channel、PO、supplier、identity、decisionContext 或来源 Communication。

**审批发送**：Approve & Send 只把经版本复核的草稿原子排入 Outbox。UI 先显示“Queued / Waiting for connector receipt”；只有真实发送回执为成功时显示“Sent”。外部结果未知时保留 Outbox ID、幂等键和恢复入口。

**审计**：记录 actor、draft ID、版本、channel、旧/新 recipient 的掩码值与规范化哈希、subject/body 内容哈希、原因和关联 PO；不在审计 metadata 保存完整 recipient 或正文副本。Discard 采用追加式状态，不删除历史。

### 9.4 Local 与 Import

**骨架**：左侧 Navi Assistant；右侧标题、KPI/风险概览、阶段页签、搜索与 Risk/Supplier/RIHD 筛选、Filter、Export、PO 表。两页使用同一组件和 route 参数，内容、会话与筛选严格隔离。

**主表固定字段**：

1. PO Number
2. Supplier
3. Material Type
4. Current Stage
5. RIHD
6. Days to RIHD
7. Risk
8. Next Action
9. Total Value
10. Row Actions

运输事实、ETA、清关、单证和路线证据不占主表列，进入 PO Detail、行级详情抽屉或 Actions。

**Assistant**：只读取同租户、同用户、同 route 的持久化会话和真实组合；附件继续执行格式、大小、对象存储、SHA-256、ClamAV、解析与 `clean + parsed` 门禁。Assistant 默认只读，不能借自然语言绕过路线确认、发信、审批、Odoo、运输或 GRN 动作。

**服务端导出**：新增 `POST /api/procurement/routes/:route/exports`，请求体接收与列表相同的规范化筛选和排序，并要求 `Idempotency-Key`。服务端按租户/route 查询并生成 RFC 4180 CSV；响应冻结筛选、生成时间、数据水位、行数和内容哈希，并写下载审计。授权下载端点只读取已经生成的 export；浏览器不再自行拼业务 CSV。

**现有动作**：查看详情、发送跟进、修改 RIHD、标记风险继续走真实权限、幂等、版本、状态机和审计。路线确认必须绑定 ERP/合同/Incoterm/人工复核证据；不得按供应商名称、邮箱域、币种或地址片段猜路线。

### 9.5 PO Detail 总体

**页头**：面包屑 → PO Number、状态摘要、供应商、RIHD → Actions。固定六页签为 Overview、Items、Supplier、Documents、History、Communication，URL 使用稳定 `poId` 与 `poTab`，刷新和前后退可恢复。

**对象身份**：所有关联供应商必须通过当前 PO 的 `supplierId` 在同租户读取；不按供应商名称、邮箱或列表位置映射。未知值显示 `—`，不使用 0、Pending 或低风险替代未知。

#### Overview

展示 PO 基本信息、下一步、五阶段纵向 Timeline、风险摘要、审批与 SLA。阶段只由 Confirmation、Production Progress、Shipment、Receipt/GRN 等不可变事实投影。每阶段默认显示状态与说明，证据、时间、规则和置信度渐进披露。

#### Items

固定字段：Item/Description、Category、Ordered Quantity、Confirmed Quantity、Unit、Unit Price、Tax、Total、Shipped、Received、Status。页头显示项目数、分类数、已确认/已发运/已收货汇总；缺失事实保持未知。金额使用行币种与精度，不跨币种相加。

#### Supplier

显示 Code、Name、Status、Type、Industry、Address、Country、Primary Contact、Email、Phone、Payment Terms、Contract Period、Route、Criticality 和 Material Lead Times。关联 PO 与绩效属于次级区块；缺少业务档案时指出缺失字段，不从 Odoo 名称猜补。

#### Documents

页头 KPI：Total、Verified、Pending、Missing；工具条：Search、Filter、Category。表格显示 Document、Category、Source、Version、Security/Processing Status、Verified、Updated、Actions。文件只有通过安全与解析门禁才可用于业务证据；Missing 是规则要求与已有文件的差集，不创建假文档行。

#### History

主列显示规范事件类型、actor、摘要、时间和证据引用；右侧显示 PO Details 与 Stage Timeline。事件类型通过服务端映射表把阶段、审批、动作、SLA、路线、风险和外部回执映射为稳定用户语言，未知类型显示原始安全名称，不丢弃事件。

#### Communication

显示 Total、Inbound、Outbound、Pending Drafts KPI；主线程按持久化发生时间排序，右侧显示 Related Threads。草稿可在页内 Send/Edit，但调用同一 Draft/Outbox 服务。Related Thread 导航与消息不能直接改变 PO 阶段。

### 9.6 PO Actions

Actions 菜单宽 180px，固定顺序：Edit PO、Duplicate、Download PDF、Print、Cancel PO。Edit 与 Duplicate 使用 560px 桌面弹窗；Cancel 使用危险语义和二次确认。

#### Edit PO

- 新端点：`POST /api/procurement/execution/edit_po`。
- 输入：`aggregateId`、`expectedVersion`、白名单 patch、`reason`、`Idempotency-Key`。
- Readywork 来源且仍为 Draft 的 PO 可原子修改供应商、RIHD、物料类型、允许的行字段和联系人引用。
- Odoo 来源或已进入执行阶段的 PO 不允许静默本地覆盖；保存为 `purchase_order_amendment`，经业务门禁后排入 Odoo Outbox，回执成功后重载权威 PO。
- route 变更继续使用独立证据合同；Stage、Status、已确认/发运/收货数量、外部 ID 和历史不可编辑。
- supplier 变更只允许无执行事实的 Draft，并验证同租户 supplierId；Supplier Name/Email 是显示值，不是身份键。

#### Duplicate

复用现有真实纵切。新 Draft 只继承允许的供应商、币种、行、税务字段和用户填写的新 PO Number/RIHD；不继承外部映射、上游关系、附件、执行事实、异常、沟通或历史。成功后必须在权威工作集中读取到新 ID 才关闭弹窗并跳转。

#### Download PDF 与 Print

- 新端点：`POST /api/procurement/purchase-orders/:id/document-snapshots` 创建版本化确定性投影，输入 `expectedVersion`、用途 `download|print`、`Idempotency-Key`。
- 服务端从同一 PO Context 水位生成 HTML 与 PDF，冻结 PO ID/version、context watermark、生成者、生成时间、模板版本、内容哈希和关联 document ID。
- PDF 保存到现有对象存储/文档层，元数据进入 SQLite；下载使用授权的短时流式端点，不暴露对象存储密钥。
- Print 打开同一 snapshot 的打印专用 HTML，不用浏览器当前 DOM 拼业务事实。打印视图明确标注“system-generated snapshot”，不冒充签署原件。
- 生成失败、字体/模板失败或对象存储失败不得显示下载成功；重试复用相同幂等键。

#### Cancel PO

- 新端点：`POST /api/procurement/execution/cancel_po`，不使用物理 DELETE。
- 输入：`aggregateId`、`expectedVersion`、`reason`、`Idempotency-Key`。
- 服务端复核 `operate + approve`、活动状态、无收货/GRN、无不可逆发运、无已结发票以及外部系统可撤销性。
- 无 Odoo 映射时，同一事务追加 `purchase_order.cancelled`、版本、Activity、幂等回执和审计。
- 有 Odoo 映射时先记录 cancel request 并排入 Outbox；UI 显示等待回执。只有 Odoo 明确成功且回读一致后投影为 Cancelled。失败或结果未知时保持 Pending/Needs attention，不冒充已取消。
- 行、附件、沟通、阶段、外部映射和历史全部保留。

### 9.7 Risk Dashboard 与 RiskModelV2

**骨架**：日期范围 → 五张 KPI → 风险分布、风险拆解、供应商、账龄、产品和趋势图 → High-risk PO 表。图表与表格读取同一不可变快照。

**公开计算模型**：

```text
Supplier Performance  30%
Delivery Delay        25%
PO Value              20%
Product Criticality   15%
Compliance & Approval 10%

total = round(0.30*S + 0.25*D + 0.20*V + 0.15*C + 0.10*A)
```

每个 component 为 0–100。阈值保持 High ≥ 70、Medium ≥ 40、Low < 40。

**缺证据处理**：

- 每个 component 返回 `score: number | null`、`evidenceState: observed|derived|missing|stale`、evidence references 和 observedAt。
- `evidenceCoverage` 为已具备可用证据的权重之和，范围 0–1。
- 缺失 component 不填 0。`totalScore` 只有五个 component 均具备可用证据、即 coverage=1.00 时才按公开公式发布。
- coverage ≥ 0.70 且 Delivery Delay 有证据时，可以计算仅用于排查和排序的 `provisionalScore`：对已观测权重重新归一化，并始终同时显示 `Provisional` 标签、coverage 和缺失 component；它不能写入 `totalScore` 或冒充正式风险等级。
- coverage < 0.70 的 PO 显示 `Score not published`；缺证据本身可形成 `data_quality` 风险提示。

**RiskModelV2 类型**：

```ts
type RiskComponent = {
  score: number | null;
  weight: 0.30 | 0.25 | 0.20 | 0.15 | 0.10;
  evidenceState: "observed" | "derived" | "missing" | "stale";
  evidenceReferences: Array<{ type: string; id: string; version: number | null }>;
  observedAt: string | null;
};

type RiskModelV2Result = {
  modelVersion: "risk-model-v2";
  components: {
    supplierPerformance: RiskComponent;
    deliveryDelay: RiskComponent;
    poValue: RiskComponent;
    productCriticality: RiskComponent;
    complianceApproval: RiskComponent;
  };
  evidenceCoverage: number;
  totalScore: number | null;
  provisionalScore: number | null;
  provisionalBand: "high" | "medium" | "low" | null;
  band: "high" | "medium" | "low" | "unpublished";
};
```

`evidenceCoverage` 只累计 `observed` 与仍在有效期内的 `derived` component 权重；`missing` 与 `stale` 不累计。每个命名 component 的 `weight` 必须等于公开模型中对应的固定值，validator 拒绝错配。

**快照**：冻结模型版本、权重、组件值、证据、coverage、阈值、输入水位、租户设置版本、supplier profile 版本和生成时间。列表、图表、CSV 和 PO 下钻只读取该快照；旧模型快照保留原版本，不用 V2 回填。

### 9.8 Suppliers 与 Supplier Operating Profile

**骨架**：页头与 Add Supplier → KPI → Search/Route/Type/Criticality/Status 筛选 → 供应商表 → 详情弹窗。主表优先显示 Code、Supplier、Country、Route、Type、Material、Lead Time、Criticality、Status、Actions；绩效分数和证据放入详情。

**业务档案**：在现有 supplier master 之上增加一对一版本化 `SupplierOperatingProfile`：

```ts
type PostalAddress = {
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
};

type SupplierOperatingProfile = {
  supplierId: string;
  countryCode: string | null;
  route: "local" | "import" | "unclassified";
  supplierType: "manufacturer" | "distributor" | "service" | "other";
  industry: string | null;
  address: PostalAddress | null;
  primaryMaterialCode: string | null;
  primaryMaterialName: string | null;
  defaultLeadTimeDays: number | null;
  productCriticality: "high" | "medium" | "low" | "unclassified";
  paymentTerms: string | null;
  contractStartsOn: string | null;
  contractEndsOn: string | null;
  status: "active" | "inactive";
  version: number;
};
```

**Add/Edit**：Add Supplier 同一流程收集 code、name、currency、contact、email、phone、Country、Route、Type、Material、Lead Time、Criticality；基础主数据与 profile 在一个事务中创建。Edit 使用白名单和 expectedVersion；Odoo 权威字段通过同步/变更建议处理，不静默覆盖。More Actions 固定为 View details、Edit supplier、Manage lead times、View purchase orders、Deactivate/Reactivate，不物理删除。

**Material Lead Times**：继续使用现有真实模板；表单对齐 Supplier、Route、Material code/name、Lead time days、Remarks、effective date 和 reason。规则匹配冻结模板 ID/version；无模板不猜默认天数。

### 9.9 SLA

**骨架**：标题与 Add New Rule → Search/Status/Process → 七列表：Process/Stage、Description、SLA Target、Grace Period、Escalation After、Applies To、Status/Actions。匹配为空固定显示 `No SLA rules match your filters.`

**Add/Edit 主表单**：Process/Stage、Description、SLA Target days、Grace Period days、Escalation After days、Applies To、Status。Calendar Mode、风险/路线/渠道、跟进间隔和治理证据放入 Advanced options。

**治理**：草稿、发布、退役、双权限、工作日历、评估事件和审计全部保留。Policy Governance & Runtime 默认折叠或独立管理，不抢占规则目录首屏。未发布时页面明确区分 Draft 与 No published policy。

### 9.10 Advanced SLA schema v2

**骨架**：左侧九域导航；右侧当前域标题、Search rules、Status、Template、Upload CSV、Add Rule；Rules、Validation Results、Upload History、Version History 四页签。

**九域固定顺序**：

1. Production / Service Milestones
2. Communication and Escalation Rules
3. Payment Term Rules
4. Logistics Planning Rules
5. Logistics Handover Requirements
6. Transit Monitoring Rules
7. Regulatory and Import Approval Rules
8. Customs Clearance Rules
9. Quality Inspection and GRN Rules

参数类型使用九个稳定接口组成的判别联合：

```ts
type AdvancedSlaRuleV2Parameters =
  | ProductionServiceMilestoneParametersV2
  | CommunicationEscalationParametersV2
  | PaymentTermParametersV2
  | LogisticsPlanningParametersV2
  | LogisticsHandoverParametersV2
  | TransitMonitoringParametersV2
  | RegulatoryImportApprovalParametersV2
  | CustomsClearanceParametersV2
  | QualityInspectionGrnParametersV2;
```

每个接口包含与所属域相同的 `domain` 字面量，并且只能包含下方字段表列出的必填和可选字段。共同 validator 要求 base `domain`、parameters `domain` 和所在 section 三者相同，拒绝未知字段。

#### 共同元数据

每条 v2 规则必须包含：

```ts
type AdvancedSlaRuleV2Base = {
  schemaVersion: 2;
  ruleId: string;
  name: string;
  domain: AdvancedSlaDomain;
  companyCode: string;
  businessUnit: string;
  stage: AdvancedSlaStage;
  route: AdvancedSlaRoute;
  risk: AdvancedSlaRisk;
  channel: AdvancedSlaChannel;
  effectiveFrom: string;
  effectiveTo: string | null;
  priority: number;
  status: "draft" | "active" | "inactive" | "retired";
  createdBy: string;
  approvedBy: string | null;
  lastUpdated: string;
  notes: string | null;
  parameters: AdvancedSlaRuleV2Parameters;
};
```

`createdBy`、`approvedBy`、`lastUpdated` 由服务端会话与事件生成，CSV 不允许伪造。priority 范围 1–1000，数值越小优先级越高；同作用域/日期重叠且优先级相同为验证错误。`effectiveTo` 必须晚于或等于 `effectiveFrom`。

#### 九域参数字段族

v2 保留现有参数并补齐类型化字段，禁止自由 JSON 作为主编辑界面：

| 域 | 必填参数 | 可选/条件参数 |
|---|---|---|
| Production / Service Milestones | supplierScope、itemOrService、milestoneSequence、standardDurationHours、updateCadenceHours、startEvidence、completionEvidence、supplierContactRole | blockingRuleIds、calendarMode、toleranceHours |
| Communication and Escalation | eventType、firstResponseHours、firstReminderHours、secondReminderHours、managerEscalationHours、escalationChannels、supplierLevel1Role、supplierLevel2Role、supplierLevel3Role、三档 risk | messageTemplateId、internalOwnerRole、quietHoursPolicy |
| Payment Terms | paymentTerm、triggerEvent、preparationHours、completionSlaHours、blockingStage、requiredDocuments、responsibleFunction、lcRequired | lcDetails（lcRequired 时必填）、currency、amountThreshold |
| Logistics Planning | planningActivity、bookingLeadTimeHours、capacityRequirement、planningEvidence、responsibleFunction | transportMode、incoterm、originCountry、destinationCountry、carrierConfirmationHours |
| Logistics Handover | handoverRequirement、requiredEvidence、documentTemplates、handoverSlaHours、responsibleFunction | handoverLocation、custodyFromRole、custodyToRole、sealRequired |
| Transit Monitoring | transitMilestone、updateCadenceHours、exceptionTemplate、escalationTemplate、trackingEvidence、responsibleFunction | transportMode、etaToleranceHours、missedUpdateRisk、carrierRole |
| Regulatory / Import Approval | approvalName、authority、dependencyRuleIds、preparationHours、approvalSlaHours、requiredDocuments、approvalEvidence、responsibleFunction | jurisdictionCountry、permitType、expiryWarningDays |
| Customs Clearance | clearanceMilestone、requiredDocuments、blockingRuleIds、clearanceSlaHours、escalationTemplate、clearanceEvidence、responsibleFunction | customsRegime、brokerRole、dutyPaymentSlaHours、demurrageRiskHours |
| Quality Inspection / GRN | inspectionType、inspectionSlaHours、grnSlaHours、requiredEvidence、qualityOwnerRole、grnOwnerRole、rejectionEscalationRole、acceptanceCriteria | samplingPlan、defectTolerance、reinspectionSlaHours、grnBlockingRuleIds |

数值单位统一为 hours/days 并在字段名中表达；日期为 ISO date，时间戳为 UTC ISO datetime，显示使用租户时区。依赖字段使用当前 profile 的真实规则选择器；统一 validator 拒绝缺失、自依赖和任意长度循环。

#### CSV 模板与导入

- 每个域提供独立 `Download Template`，列为 v2 共同元数据的可输入部分加该域平铺参数；不再要求 `scope_json` 或 `parameters_json`。
- 导出模板包含 `schema_version=2`、字段说明、允许枚举和日期/数字格式，但不包含示例业务行。
- 上传先创建持久化 validation batch，逐行返回 row number、normalized rule ID、severity、field、code、message。
- 汇总显示 Total Rows、Valid Rows、Invalid Rows、Warnings。`Apply Valid Rows` 仅导入合法行；若合法行之间相互冲突或形成循环，则整个合法候选集拒绝应用。
- Apply 使用 batch version + profile version + candidate hash 三重校验，在一个事务中写 profile draft、import result、version event 和审计。
- 同一 validator 同时服务手工表单、JSON API、CSV preview/apply 和 runtime evaluator。

#### 历史页签

- Validation Results：规则/行、字段、严重度、错误码、消息、验证时间、profile/candidate version。
- Upload History：文件名、SHA-256、域、总/合法/非法行、状态、上传者、上传时间、应用者、应用时间、batch version。
- Version History：profile version、schema version、status、规则数、变更来源、created/approved actor、created/published/retired time、diff summary。
- 历史只来自持久化记录；正式库为空时显示 0 和真实空态。

#### 自动发送

Auto-send 默认关闭。启用必须同时满足 configure + approve、已发布 v2 profile、具名采购身份、channel allowlist、stage/risk allowlist、供应商目标已验证、连接器健康、kill switch 未暂停和消息内容安全门禁。候选先形成持久化 draft；自动路径只有在明确策略允许时原子排入 Outbox。每次决策记录 profile/version、rule IDs、PO、draft、decision code 和 Outbox ID，不记录正文或凭据。

### 9.11 Configuration

**General Settings**：Country、Working Days、Enable SLA Escalations、Exclude Weekends、Exclude Public Holidays、Auto-calculate Lead Time、Timezone、Date Format、版本、依据和 Save Changes。只有真实 PUT 成功后更新上下文；设置只影响后续计算，不改写历史快照。

**Agent Setup**：首屏固定 Email、WhatsApp、WeChat 三张通信卡；ERP/Odoo 作为 Readywork 扩展放在下一层 Business Systems。每张卡直接显示 Runtime、Credential、External Verification、Last Tested、Health 与下一步。

**WhatsApp**：当前正式能力为 Meta WhatsApp Cloud API 模板与签名 Webhook时，卡片明确显示 `Cloud API`，不显示假的 QR/pairing。未来个人 Linked Devices 连接器必须独立评审、独立 connector type、独立法律和账号隔离契约，才能显示 QR。

**WeChat**：没有已验证 connector 时显示 Not available / Not configured 和管理路径，不放置可点击假连接。

**Auto-send follow-ups**：开关旁明确说明启用后哪些消息可能绕过 Drafted Emails 人工队列；展示 profile version、allowlist、双权限、identity、connector 和 kill switch 状态。任何条件不满足时开关禁用并列出阻断。

**Advanced Governance**：默认折叠。非管理员只读取脱敏 readiness 与三通道摘要；管理员才挂载连接器目录、凭据、外部测试、安全事故和运行控制。403 显示管理边界，不渲染假 0。

### 9.12 Product、登录与法律页

- `/product` 使用 Readywork 自有 Logo、截图、插图和文案，说明监督式采购执行、人工审批和真实连接边界。
- Demo 表单继续走真实 API、幂等、SQLite 和审计；成功不暗示已发邮件或写 CRM，除非后续接入并取得回执。
- 登录页保留真实会话、过期恢复、SSO 未配置与本地验收边界，品牌为 Readywork。
- Privacy/Terms 只能陈述已经确认的运营主体、数据范围、保留、处理商和法律状态；未批准事实保持 pre-release 说明，不复制参考公司的地址、电话、认证或管辖。

## 10. API 变更总表

| 能力 | 合同 |
|---|---|
| Draft recipient | 扩展现有 message draft PATCH：recipient + subject + body + expectedVersion + reason |
| Route export | `POST /api/procurement/routes/:route/exports`，复用列表筛选、幂等生成服务端 CSV 与审计 |
| Edit PO | `POST /api/procurement/execution/edit_po`，白名单 patch、版本、幂等、来源策略 |
| PO document snapshot | `POST /api/procurement/purchase-orders/:id/document-snapshots` 与授权读取端点 |
| Cancel PO | `POST /api/procurement/execution/cancel_po`，追加取消事实或外部 pending request |
| Risk V2 | 扩展 risk snapshot/read API，返回模型版本、五组件、coverage、证据和阈值 |
| Supplier profile | Supplier create/read/update 增加 versioned operatingProfile；More Actions 复用专用端点 |
| Advanced SLA v2 | 现有 profile 路由接受/返回 schema v2；新增按域模板下载与逐行 validation detail |
| Configuration | 保留 tenant preferences 和 connection summary；Auto-send readiness 返回精确阻断 |

所有新增/扩展端点必须使用现有统一错误外形，稳定返回 401/403/404/409/422/500 语义；错误体包含安全 code、可显示 message、request/correlation ID 和当前版本（409 时），不包含敏感数据。

## 11. SQLite migration 设计

### 11.1 迁移编号与原则

本规格基线为 migration 48，实施时使用 migration 49：`navisight-clean-room-alignment-v2`。若审核到执行之间仓库已经新增 migration，则仅把该迁移机械顺延为当时的下一个连续编号，表结构与验收不变。

迁移必须在 `BEGIN IMMEDIATE` 中执行并重检版本；新旧进程并发时只有精确后置条件已经成立才容忍重复列/索引。迁移不得创建样例 supplier、PO、rule、snapshot、message 或 connector。

### 11.2 新增/扩展持久化

1. `procurement_supplier_operating_profiles`
   - `tenant_id, supplier_id, version, country_code, route, supplier_type, industry, address_json, primary_material_code, primary_material_name, default_lead_time_days, product_criticality, payment_terms, contract_starts_on, contract_ends_on, status, created_at, updated_at`
   - 主键 `(tenant_id, supplier_id)`；枚举 CHECK；version ≥ 1；日期范围检查。

2. `procurement_supplier_operating_profile_events`
   - 追加保存 before/after 的最小必要差异、actor、reason、source、version、time；不重复保存无关联系人密文。

3. `procurement_purchase_order_amendments`
   - 保存 edit/cancel request、source PO version、normalized patch、state、Odoo Outbox/receipt reference、idempotency key、actor、reason 和时间；不能替代 PO 权威事实。

4. PO document snapshot 元数据
   - 优先扩展现有 `procurement_documents`/对象存储引用，增加 `snapshot_kind, source_po_version, context_watermark, template_version, content_sha256, generated_by, generated_at`；若现表约束无法无损扩展，则建立 `procurement_purchase_order_document_snapshots` 并引用现有 document ID。

5. `procurement_route_exports`
   - `tenant_id, id, route, normalized_filters_json, source_watermark, row_count, content_sha256, object_key, state, created_by, created_at, expires_at, idempotency_key`。
   - 同租户才能读取；对象在过期后可清理，但生成/下载审计永久保留且不含 CSV 正文。

6. Risk snapshot JSON v2
   - 现有不可变快照 payload 增加 `modelVersion, weights, thresholds, components, evidenceCoverage, totalScore, provisionalScore, provisionalBand, evidence, inputWatermark`；不改写旧 payload。

7. Advanced SLA
   - profile 增加 `schema_version INTEGER NOT NULL DEFAULT 1`；v2 草稿保存 `schema_version=2`。
   - import batch 增加 template/schema version、domain、source SHA-256、total/valid/invalid/warning counts、candidate hash、validation result JSON 和 applied actor/time。
   - 现有 v1 profile 保持可读；首次编辑时显式执行 v1→v2 upgrade preview，不静默发布。系统生成共同元数据中的 actor/time，v1 规则缺少 companyCode/businessUnit/effectiveFrom 时标记 migration validation error，要求用户补齐后才能发布。

### 11.3 回滚与兼容

- 迁移是向前兼容的加法；不删除旧列、旧 JSON、旧事件或旧快照。
- 旧 API 客户端读取时可获得兼容 view，但任何 v2-only 写操作要求 schemaVersion 2。
- 数据迁移失败整体回滚；不得留下半张 profile 或部分 supplier profile。
- 备份、integrity check 和 schema version 只读核对列入实施验收，但本规格阶段不创建备份或运行迁移。

## 12. Temporal、Outbox 与外部副作用门禁

| 动作 | SQLite 成功点 | 外部阶段 | UI 最终成功点 |
|---|---|---|---|
| Approve & Send | draft approved + Outbox queued | Email/WhatsApp dispatch + receipt | receipt=`succeeded` |
| Edit Odoo PO | amendment persisted + Outbox queued | Odoo update + readback | Odoo readback matches |
| Cancel Odoo PO | cancel request persisted + Outbox queued | Odoo cancel + readback | PO projected Cancelled after receipt |
| Duplicate | 新 Draft、行、事件、审计同事务 | 无默认外部动作 | 权威工作集可读取新 ID |
| Generate PDF | snapshot metadata + object committed | 对象存储 | 授权读取与 hash 可验证 |
| Route export | audit/download record | 无外部写 | CSV stream 完整返回 |
| Advanced auto-send | decision + draft + optional Outbox | connector dispatch | receipt=`succeeded`；运行事件可追溯 |

Temporal workflow ID 与 activity 重试必须稳定；相同业务幂等键重放返回同一结果。Worker 不得把网络超时解释为失败后自动创建第二条外部动作。kill switch、connector disabled、credential rotation、身份未配置或权限撤销在领取和外呼前都要复核。

## 13. 权限与审计矩阵

| 能力 | 最低权限 | 额外门禁 | 审计 |
|---|---|---|---|
| 页面读取 | read | tenant/object scope | 敏感读只记摘要 |
| 通知已读 | read | user-owned notification | read event |
| 编辑草稿 | operate | expectedVersion、channel validation | before/after hash + recipient diff |
| 批准发送 | approve | named identity、connector、draft version | approval + Outbox + receipt |
| Edit/Duplicate PO | operate | state/source/version/idempotency | amendment or creation events |
| Cancel PO | operate + approve | reversible state、reason、external receipt | request + final outcome |
| Supplier Add/Edit | configure | supplier/profile version | master/profile event |
| SLA draft | configure | expectedVersion | policy event |
| SLA publish/retire | configure + approve | validation/readiness | immutable version event |
| Advanced CSV apply | configure | batch/profile/candidate versions | import + diff + event |
| Auto-send enable | configure + approve | all readiness gates | policy + runtime event |
| Connector manage | admin | current credential state | credential/connection event |

审计事件使用稳定 action code、tenant、actor、object type/id、version、reason、correlation/idempotency reference 和 outcome。失败的权限/验证/连接器动作也记录安全摘要，但不保存密码、token、完整正文或文件内容。

## 14. 状态与错误体验矩阵

| 状态 | 页面行为 |
|---|---|
| Loading | 保留骨架和明确进行中说明；不闪现业务空态 |
| Empty | 说明“没有持久化记录”及最短真实创建路径；不生成样例 |
| Read error | 显示错误、request ID、重试；有缓存时标记陈旧水位 |
| 401 | 统一会话过期并回登录 |
| 403 | 显示权限所有者/联系管理员；不显示假 0 |
| 404 | 对象已不存在或不可见，提供返回来源列表 |
| 409 | 保留输入、显示服务器版本、提供 reload/review |
| 422 | 定位到具体字段/CSV 行和规则错误码 |
| Connector not ready | 禁用外部动作，列出缺少 identity/credential/test/runtime 的精确项 |
| External pending | 显示请求 ID、开始时间和恢复状态；禁用重复提交 |
| External unknown | 显示 Needs attention，不宣称成功/失败；保留人工核查路径 |
| Kill switch | 自动路径停止，人工受审动作按独立门禁；历史不删除 |

## 15. 测试与验收矩阵

### 15.1 单元与合同测试

- 十项导航精确标签、顺序、section 和无 Developer 一级入口。
- Draft recipient 的 Email/WhatsApp 正常化、占位拒绝、版本冲突、审计脱敏和批准重放。
- PO Edit 白名单、来源策略、阶段/状态拒绝、supplierId 租户隔离。
- Duplicate 不继承外部映射、执行事实、附件和历史。
- PDF/Print 使用同一 context watermark、模板版本与哈希；授权和对象存储失败不假成功。
- Cancel 的状态机、已发运/已收货/发票阻断、Odoo pending/success/unknown、幂等和不可变历史。
- RiskModelV2 五权重计算、70/40 阈值、coverage、缺证据、旧快照兼容和模型版本冻结。
- Supplier profile 枚举、日期、lead time、Add/Edit/Deactivate、Odoo 权威字段和关联一致性。
- SLA 七列表、Add/Edit 主字段、工作日历和发布/退役门禁。
- Advanced SLA v2 九域 JSON/CSV 无损 round-trip、共同元数据、按域字段、日期/优先级冲突、逐行验证、合法行应用、依赖图、迁移兼容和 runtime evaluator。
- Configuration 的 manager/admin 边界、Cloud API 诚实状态、auto-send readiness 和 kill switch。
- Readywork 品牌、无生产 Navisight 资产、无外部参考域请求。
- 组件包装层不会绕过服务端数据/权限/成功契约；商业功能开关在无生产 entitlement 时 fail closed。

### 15.2 API、持久化与并发测试

- 所有写端点覆盖 401/403/404/409/422、tenant isolation、expectedVersion 和 Idempotency-Key。
- SQLite migration 49 在空临时库、migration 48 临时副本、已迁移库重启和双进程竞争下通过。
- 事务中途失败不留下半个 supplier profile、PO amendment、document snapshot、import batch 或 Outbox。
- 同键同载荷返回同一结果；同键不同载荷 409。
- SSE 失效后重载权威对象，不用事件 payload 覆盖完整状态。
- 正式数据库只执行经授权的只读检查；写测试全部使用隔离库。
- 新依赖使用精确版本；许可证账本、SPDX/NOTICE、传递依赖、trial/生产授权和 OSS fallback 检查通过。

### 15.3 外部集成测试

- fake/local connector 验证 queued→succeeded、queued→failed、queued→unknown、credential revoked 和 kill switch。
- Odoo 写入后 readback 不一致不能显示成功。
- Email/WhatsApp 回执与草稿/Outbox/Communication/审计关联一致。
- 自动发送缺任一门禁均 fail closed，且不创建外部请求。

### 15.4 桌面视觉与交互验收

每个一级页面与 PO 六页签在 1280×720、1440×900、1920×1080 验收：

- 页面 `scrollWidth === clientWidth`；仅宽表内部允许水平滚动。
- 固定导航、页头、筛选、主区块、空态、弹窗和 Actions 不遮挡。
- 正常、空、错误、无权限、409、连接器未就绪、外部 pending/unknown、kill switch 均可截图复核。
- 键盘支持侧栏、页签、菜单、弹窗焦点陷阱、Escape、Home/End 和可见 focus ring。
- 浏览器 console 0 error / warning；网络面板无 Navisight 资源请求。

### 15.5 数据与副作用验收

实施前后对正式 SQLite 做只读计数与 integrity 对比。除用户明确执行的真实业务动作外，自动化验收不得改变 PO、route、SLA、supplier、security incident、Outbox、Odoo、Email 或 WhatsApp。任何测试产生的业务行都必须位于可销毁隔离库，并带明显 test tenant。

## 16. 发布分片

本规格是统一架构合同，实施应拆成可独立验收的纵向分片；每片均先测试、再实现、再做隔离浏览器与持久化验证：

1. **依赖、品牌、壳与十项 IA**：许可证账本、精确版本与组件包装层；Readywork 品牌、固定导航、旧深链兼容、开发入口隔离。
2. **Overview、Notifications、Drafted Emails**：读路径密度、recipient 编辑、真实发送状态。
3. **Local/Import**：固定表格列、Assistant 保留、服务端导出和行级动作。
4. **PO 六页签数据契约**：Items/Supplier/Documents/History/Communication 完整字段和一致映射。
5. **PO Actions**：Edit、Duplicate 回归、PDF/Print、Cancel 及 Odoo/Outbox 状态机。
6. **RiskModelV2**：模型、快照、Dashboard、导出与旧版本兼容。
7. **Suppliers**：Operating Profile、Add/Edit/More、Lead Times 和风险消费。
8. **SLA 与 Advanced SLA v2**：基础规则目录、schema/CSV/history/runtime 全纵切。
9. **Configuration**：General Settings、Agent Setup、auto-send 和治理权限。
10. **Product/Legal 与全局验收**：自有资产、法律事实、三视口、品牌扫描和发布 readiness。

分片之间通过本规格中的稳定类型和 API 连接，不允许临时 mock 占位。某片未完成时对应入口可以诚实显示未就绪/权限态，但不能显示假数据或假成功。

## 17. 发布与回退

- 所有 schema 变化先向前兼容，再切换读路径，最后启用写路径；不做破坏式 big-bang migration。
- RiskModelV2 以模型版本并存，旧快照继续可读；新快照只由 V2 生成。
- Advanced SLA v1 只读兼容，v2 发布前必须完成显式 upgrade validation；可回退到最近已发布不可变 profile version。
- PO 外部动作可通过 runtime/connector kill switch 停止新任务，但已领取任务进入可观测恢复，不静默丢弃。
- 前端回退不得回退数据库 migration 或删除新事件；旧 UI 必须能忽略新增字段。
- 发布 readiness 继续以真实 11 项门槛为准。完成 UI 对齐不等于自动关闭具名身份、正式 SLA、安全事故、真实 Local PO、五阶段和最终 GRN 阻断。

## 18. 最终验收清单

- [ ] 生产 UI 只使用 Readywork 品牌和自有资产。
- [ ] 选定组件均使用精确版本，许可证账本完整；商业试用组件已有生产 entitlement 或已切换 OSS fallback。
- [ ] 十项一级导航顺序精确，无采购 Developer 入口。
- [ ] 十个页面与 PO 六页签符合本规格骨架、密度和状态。
- [ ] Drafted Emails 可安全编辑 To/Subject/Body，投递回执真实。
- [ ] Local/Import 主表固定九个业务字段加 Actions，导出为服务端权威 CSV。
- [ ] PO Actions 五项全部为真实纵切；Stage/Status 不可前端覆盖，取消不物理删除。
- [ ] RiskModelV2 按 30/25/20/15/10 计算并公开 coverage 与模型版本。
- [ ] Supplier Operating Profile 与 Material Lead Times 完整持久化并按 supplierId 关联。
- [ ] SLA 简洁七列表与 Advanced SLA v2 九域/模板/验证/历史完整。
- [ ] Configuration 如实区分 Email、WhatsApp Cloud API、WeChat、ERP/Odoo 与管理权限。
- [ ] 所有动作覆盖权限、租户、版本、幂等、审计、外部 pending/unknown 和 kill switch。
- [ ] Migration、API、全仓测试、typecheck、lint、production build 和三视口浏览器验收通过。
- [ ] 正式 SQLite 未注入 Demo 数据，未因自动化验收改变采购事实或外部系统。

## 19. 审核门禁

用户审核本规格时需要确认以下冻结决策：

1. Readywork 品牌与十项英文一级 IA。
2. 100% 对齐只指本规格内可验证的桌面合同，不复制未知实现或不安全行为。
3. RiskModelV2 的权重、完整证据才发布正式总分、70% provisional coverage 门槛和 70/40 风险阈值。
4. PO Edit 的来源策略、确定性 PDF/Print snapshot 和追加式 Cancel。
5. Supplier Operating Profile 字段与 Advanced SLA schema v2 字段族。
6. 当前范围只包含三个桌面视口，手机端延期。

只有用户明确确认本规格后，下一步才使用 writing-plans 工作流编写详细实施计划；在此之前不进入生产代码修改。
