# Navisight 官网公开证据盘点

盘点日期：2026-08-30（Asia/Shanghai）  
来源页面：[https://navisight.ai/#solution](https://navisight.ai/#solution)（页面 canonical 为 `https://navisight.ai`）

本文件只记录页面源码中可验证的公开事实。截图中的数字、状态和标注是产品演示素材中的可见内容，不应被解释为真实客户数据或已验证的产品能力。

## 2026-08-30 实时浏览器复核

- 在公开生产站点重新读取完整 DOM 与全页视觉证据；页面 title 、`problem / gap / solution / how-it-works / risk-visibility / value / why-us / faq / demo` 分段与下文记录一致。
- 顶部、页脚与主 CTA 仍只连接当前 landing page 的锚点；landing page 本身没有产品登录、公开 demo 或独立应用页链接。不过独立入口 `https://app.navisight.ai/` 可公开访问并显示登录页，前端静态包还公开了产品信息架构。因此“逐页对齐”的证据边界现在是：官网单页、10 个公开截图资产、独立应用登录页，以及静态包中可验证的页面/字段/动作名称；未登录状态不能证明写动作真实执行。
- Overview、Notifications、AI Summary、Drafted Emails、PO Timeline、Risk Dashboard、KPI Row、Local Donut 和 Import Donut 的 Next Image 资产 URL 与 alt 语义未变；它们仍是静态 `<img>`，不是可操作 iframe。
- FAQ “What happens when Navisight detects a discrepancy?” 已用可见按钮复核，`aria-expanded` 从 `false` 切换为 `true`；Demo 选项在 DOM 中可读。本次未提交 Demo 表单，不把未观测的服务端响应当成已完成能力。

## 2026-08-31 Demo 表单字段复核

- 当前官网 Demo 表单包含一个不可见 `website` honeypot，以及 8 个用户字段：`fullName`、`email`、`company`、`role`、`country`、`erp`、`poVolume`、`message`。只有 Full name、Work email、Company 带 HTML `required`。
- 占位符依次为 Jane Doe、jane@acme.com、Acme Ltd、Head of procurement、United Arab Emirates，以及 “A selected group of purchase orders, a supplier region, an import route...”。这只证明前端字段合同，不证明后端一定校验相同上限或幂等语义。
- ERP 选项值 / 文案为 `sap / SAP`、`quickbooks / QuickBooks`、`other / Other`、`none / No ERP`；Monthly PO volume 为 `lt100 / Under 100`、`100-500 / 100 to 500`、`gt500 / 500+`。
- 提交按钮为 Request a Demo，辅助文案为 “No commitment. We’ll reply within one business day.”。本次只读 DOM / 可访问树与表单结构，没有填写或提交，不把成功 / 错误响应或一工作日响应承诺当作 Readywork 已经履约。
- 2026-09-01 复核时 Footer 已将 Privacy / Terms 改为真实 `/privacy` 与 `/terms` 路由；这是相对 2026-08-31 的公开变化。Readywork 可以吸收其“Legal Hero + On this page + 长文 Article”桌面信息架构，但不得复制 Navisight 的运营地区、邮箱、处理商、司法管辖或正式法律结论。

## 2026-08-31 Readywork 桌面公开页对齐

- 本地 `/product` 已补齐 `problem / gap / solution / how-it-works / risk-visibility / value / why-us / faq / demo`，导航仍使用与公开证据一致的单页锚点。
- 本地页不复制 UAE Startup Story 徽章，不采用官网截图中的 PO 编号、客户数量、金额或风险指标作为业务事实；Recognition 位置改为可验证的 V1 Employee Pack 产品标准。
- 官网 solution 提到 WhatsApp，但 Readywork 公开页只列出当前可验证边界 Odoo、Email、SMTP / IMAP 与 ERP adapters，避免把未配置通道写成现实能力。
- 已在运行中桌面页验证所有区块各自唯一、顶部 6 个导航/CTA 链接指向正确锚点、7 个 FAQ 可展开，Demo 合同保持 honeypot + 8 个字段且只有姓名/邮箱/公司必填，浏览器控制台 0 error / warning。本轮未填写或提交表单。
- 根据用户当前 V1 取舍，移动端菜单与移动布局暂不实现；这是明确延后项，不得写为已对齐。

## 页面身份与导航

- `<title>`：`Navisight | AI for Procurement Execution | Keep Every PO on Track`。
- meta description：`Navisight helps procurement teams keep every PO on track: an AI procurement agent that follows up with suppliers, tracks deliveries, and identifies execution risks before the due date is missed.`
- 顶部 logo：`/logo.png`，alt 为 `Navisight`。
- 顶部导航均为当前单页锚点：`Product` → `#solution`、`How it works` → `#how-it-works`、`Risk visibility` → `#risk-visibility`、`FAQ` → `#faq`；`Request a Demo` → `#demo`。
- 首屏可见 CTA：`Request a Demo`（`#demo`）和 `View Product Overview`（`#solution`）。移动导航存在 `Open menu` 按钮，初始 `aria-expanded="false"`。
- 页脚产品 / 公司链接仍主要连接单页锚点或外部联系方式；法律链接现为 `/privacy` 与 `/terms`。两页都复用官网顶栏，包含 Effective / Last updated、左侧编号目录和右侧长文正文；公开正文属于 Navisight 自身事实，不构成 Readywork 可直接沿用的法律声明。

## 独立产品应用与信息架构证据

公开入口：[https://app.navisight.ai/](https://app.navisight.ai/)；采集日期同上。

- 应用入口实际显示 `NAVISIGHT / Welcome back / Sign in to access your Navisight account`，包含 Email、Password 和 Sign In；这证明独立 Web 应用存在，但不构成任何登录后动作已完成的证据。
- 2026-08-31 在 1280×720 公开登录页测量：页面使用 `#f8fafc` 浅灰单屏、中央 `620px` 容器、`48px` 标志、`40px` 品牌字、`30px` 标题、`24px` 白色卡片圆角、`52px` 输入/按钮，背景含右上角点阵和底部双层浅蓝波浪。密码控件有显示/隐藏按钮；未观测登录后状态。
- 2026-08-30 的公开前端静态包可验证主导航：Overview、Notifications、Drafted Emails、Local、Import、Risk Dashboard、Suppliers、SLA、Advanced SLA、Configuration。
- Overview 静态代码可验证 PO 搜索，以及 Route、Material Type、Stage、Risk、Supplier 过滤字段；PO 行动作名称包括 Send follow-up、Edit RIHD、Mark at risk。动作名称只证明 UI 合同存在，不证明无登录状态可以安全执行。
- Advanced SLA 静态代码可验证 9 个规则分区：生产/服务里程碑、沟通与升级、付款条件、物流计划、物流交接、在途监控、法规与进口审批、清关、质量检验与 GRN；页面还包含手工/CSV 配置和自动发送跟进的界面文案。其固定 ACME / 供应商 / 规则样例是演示数据，不构成规则已持久化或已自动执行的证据。
- 应用静态代码同时包含草稿邮件、通知已读、供应商、SLA / Advanced SLA 和 Configuration 的接口调用与界面文案；部分固定演示值与真实接口消费并存，因此任何截图数字必须继续视为演示素材，不能作为客户或生产实绩。
- 公开应用的若干只读 API 在未建立登录会话时仍返回 HTTP 200。本文不记录、复制或传播其响应中的账户、订单或通知内容；该行为只作为反向安全证据：Readywork 必须对 API 默认拒绝、按租户与对象授权、脱敏并审计，绝不能为了视觉或能力对齐复制这一暴露面。
- Readywork 登录页已使用上述公开骨架重构，但保留自有品牌和中文文案；真实 `/api/auth/login → /api/auth/me` 合同、HttpOnly Cookie、失效回收和禁止匿名降级没有为视觉对齐而改弱。浏览器已验证密码显隐、自动填充后可提交、真实登录恢复业务页，以及主动退出不再被误报为“会话已过期”。

### 2026-09-01 公开应用包变化：PO Detail Actions

- `https://app.navisight.ai/` 当前入口引用的主页面包为 `/_next/static/chunks/app/page-4534461a7815b3b1.js`。只读下载得到 `401263` bytes，SHA-256 为 `e4f7dfb3c8f686a69b57862572d44aa2e7ea96be78d3ccc240e2cb9dfa4af7d1`；它已不同于本项目此前记录的 `400404` bytes / `27b04fd…a8f4d6a` 版本，因此后续逐页对齐应以本条新证据为准。
- PO 详情页头公开了 `Actions` 菜单，顺序为 `Edit PO`、`Duplicate`、`Download PDF`、`Print`、分隔线、`Cancel PO`。菜单宽 `180px`；编辑与复制共用 `560px` 弹窗，字段为 PO Number（仅复制时）、Supplier Name、Supplier Email、Contact Person、Required In-House Date、Item / Description、Procurement Route、Material Type、Stage、Status、Lead Time、Transit Time。
- 客户端合同为 `POST /api/po` 创建复制、`PATCH /api/po/{id}` 编辑、`DELETE /api/po/{id}` 取消；打印与下载两个入口当前共用浏览器打印视图，包含订单元数据、行项目、文档名称及 `Generated from NaviSight` 页脚。公开静态包只证明这些前端入口、字段和请求形状存在，不证明服务端具备版本、幂等、审批、事务、审计或写后核验。
- 当前公开取消确认文案明确称会永久删除 PO、行、文档和历史；编辑载荷还允许客户端直接传 `stage/status`。这两项与 Readywork 的不可变采购事实、事实驱动五阶段和企业系统写回门禁冲突，不能为了表面对齐照搬。Readywork 应吸收同一 Actions 信息架构和视觉几何，但把编辑收紧为字段白名单与版本化纠正，把取消实现为追加式业务事件并保留所有历史。

## 分段与可见文案

1. **Hero / 首屏**（无 section id）：`AI for procurement execution`；`Keep every PO on track.`；`From PO Sent to GRN.`；说明为 AI 跟进供应商、追踪交付并提前识别风险。
2. **The problem**（源码中 `id="problem"`）：描述 PO 发出后跨碎片化渠道追供应商、用 spreadsheets 追踪交付和风险；示例节点包括 `Your ERP / PO-430089 approved`、`Email no reply in 48h`、`WhatsApp seen 2d ago`、`WeChat last active 09:12`、`Phone calls voicemail`、`Spreadsheets PO_tracker_v3_FINAL.xlsx`。同时写有 `70% of procurement team time spent on supplier coordination after PO approval`、`Weeks lost when supplier delays go undetected until it is too late`，以及 `Lost sales the real cost.`。
3. **The gap**（源码中 `id="gap"`）：标题 `The risk is visible before the PO becomes late.`；示例信号为 `We’ll do our best.`、`48 hours. No acknowledgement.`、`MOQ is 1,000 pcs. Your PO is for 500.`、`Lab dip approval pending.`。
4. **The solution**（`id="solution"`）：`We help procurement teams keep every PO on track with AI that follows up with suppliers, tracks deliveries and identifies risks early.`；文案包括 `Know what needs attention before the PO becomes late.`、`Navisight drafts the follow-up. Your team approves.`、通过 email 和 WhatsApp 沟通且每条消息记录到 PO。
5. **How it works**（`id="how-it-works"`）：五阶段明列为 `1 PO Sent`、`2 Supplier Commitment`、`3 Fulfilment / Production`、`4 Dispatch / Transit`、`5 Delivery / GRN`。补充文案称每阶段有 SLA target/grace period、供应商沉默会触发 escalation、email/WhatsApp follow-up、import document verification、并与 ERP GRN 交叉核对。页面另有小标题 `What this looks like on a real PO`。
6. **Risk visibility**（`id="risk-visibility"`）：`See where procurement execution is at risk before delivery is missed.`，并有 `From chasing individual POs to managing execution risk across the portfolio.`。
7. **Customer value**（`id="value"`）：`Grow procurement capacity, not coordination effort.`；演示对比文案 `Manual coordination` / `AI-supported execution`、`Same Team, Greater Capacity.`。其后的公司背书区才使用 `id="why-us"`。
8. **FAQ**（`id="faq"`）：`Frequently asked questions`，7 个可展开问题：是否替代采购团队、与 SAP Ariba/Coupa 的差异、供应商是否知道在和 AI 对话、是否需要 ERP、上线时间、数据安全、发现 discrepancy 后如何处理。每项是 `button`，初始 `aria-expanded="false"`，并通过 `aria-controls` 指向答案区。
9. **Demo**（`id="demo"`）：`Let's put Navisight on your POs.`、`Start with a scoped pilot`；说明可选定一组 PO 演示风险识别，且 `Navisight owns the post-PO coordination layer and nothing else.`。表单可见字段：Full name*、Work email*、Company*、Role、Country、ERP system、Monthly PO volume、`What should the pilot cover? (optional)`。ERP 选项：Select... / SAP / QuickBooks / Other / No ERP；PO volume：Select... / Under 100 / 100 to 500 / 500+；提交按钮 `Request a Demo`，提示 `No commitment. We’ll reply within one business day.`。

## 公开产品截图/图像资产清单

下列 URL 均为同站公开静态资产，页面通过 Next image URL 引用；原始文件均为可下载 WebP（抓取验证的像素尺寸如下）。alt 文本是页面对截图内容的明确标注。

| 页面用途 | 资产 URL（原始） | 尺寸 | 页面 alt / 可见标注 |
|---|---|---:|---|
| Hero / Overview | `https://navisight.ai/_next/static/media/overview-dashboard.0y5mgs0on1e-v.webp` | 3840×2546 | Overview dashboard；156 active POs、high-risk POs、current stages、AI procurement summary |
| Risk/通知 | `https://navisight.ai/_next/static/media/notifications.0xm0oe-qrg9i1.webp` | 3840×2264 | notifications feed；escalations、SLA breaches、shipments at risk |
| AI 摘要 | `https://navisight.ai/_next/static/media/ai-summary.06e7ngmyc727j.webp` | 1385×1835 | AI Procurement Summary；4 suppliers no response、2 import shipments may miss RIHD、3 unrealistic delivery dates |
| 解决方案/邮件草稿 | `https://navisight.ai/_next/static/media/drafted-emails.0-zbg8srv7nd5.webp` | 3840×2160 | drafted emails queue；AI-written supplier follow-ups awaiting one-click review and approval |
| 解决方案/Overview | `https://navisight.ai/_next/static/media/overview-dashboard.0y5mgs0on1e-v.webp` | 3840×2546 | every purchase order、current stage、risk level in one place |
| How it works/PO timeline | `https://navisight.ai/_next/static/media/po-timeline.0~l55tv43t__8.webp` | 2477×1500 | PO timeline；前四阶段 completed，Delivery / GRN pending |
| Risk Dashboard | `https://navisight.ai/_next/static/media/risk-dashboard.0qbex7l7a_3s-.webp` | 3840×2160 | risk score distribution across 210 POs、risk by supplier、$2.85M at-risk value |
| Customer value/KPI | `https://navisight.ai/_next/static/media/kpi-row.00n03dmiyfr4c.webp` | 3840×568 | 156 active POs；96 local、60 import、risk trends |
| Customer value/local donut | `https://navisight.ai/_next/static/media/donut-local.0phwfw-pq9pe0.webp` | 2477×1240 | Local risk overview；61 of 96 POs on track |
| Customer value/import donut | `https://navisight.ai/_next/static/media/donut-import.0los_~pluo4dt.webp` | 2495×1240 | Import risk overview；93 of 148 POs on track |

另有公开品牌/社证素材：`https://navisight.ai/og.png`（Open Graph）、`https://navisight.ai/favicon.svg`、以及外链 `https://uaestartupstory.com/wp-content/uploads/2026/07/uae-startup-story-badge.png`（alt：`UAE Startup Story Accredited Startup 2026`）。

## 可见交互（以源码可验证范围为准）

- 顶部/页脚 CTA 与导航是锚点跳转；无公开产品登录入口或独立产品路由出现在该页面链接中。
- 移动端 hamburger 为按钮，标注 `Open menu`，并带 `aria-expanded` 状态。
- FAQ 7 项为折叠按钮；答案初始未展开（`aria-expanded=false`），点击应切换答案区域，但本次盘点未提交任何表单或外部动作。
- Demo 表单为原生输入、textarea、select；Full name、Work email、Company 带 `required`；提交按钮为 `type="submit"`。源码可见字段校验/提交入口，但未执行提交，因此不对后端行为作判断。
- 未发现产品截图上的公开可操作控件；截图是静态 `<img>`，不是应用 iframe 或可操作产品演示。

## 当前最重要的产品差距

可操作的 PO 风险详情/时间线已经存在，并已用正式库中的 `po:7c4c2aa5-b119-4e14-8953-a9fc78882e2a` 验证 Overview → PO 工作台 → 详情抽屉下钻。官网截图里的 `PO-430089` 只是静态演示编号，不应为了像素对齐写入正式业务库。

当前最高优先级不再是新增一个详情页面，而是补齐“**可核验的真实五阶段闭环和统一上下文证据链**”：外发连接器回执、供应商入站回复、AI 提取与判断、人工决定、阶段推进、发运/收货累计、Odoo/WMS 最终 GRN 必须关联到同一 PO，并能从详情页逐项回溯。目标 PO 已经处于 `sent`，但仍缺合法的 Odoo 映射恢复路径；在映射、供应商确认、生产、发运、收货和最终 GRN 没有真实回执前，必须保持阻断或诚实空态，不能用官网演示数字填充。

## 2026-08-31 正式运行门禁审计

权威来源：本地正式服务 `GET /api/operations/v1-readiness` 与 `data/readywork.sqlite` 只读查询。

- 当前状态为 `blocked`，11 个门禁中 7 个 ready、4 个 blocked（64%）。
- 已就绪：网易 163 企业邮箱外发、IMAP 入站轮询、本地 Odoo 19、ClamAV/附件门禁、Temporal Worker/可靠队列与死信、Manufacturing Context/Twin 投影、安全告警处置。
- 43 条不可变安全原始事件仍保留，当前聚合事故均已有修复证据；未处置 warning / critical 事故为 0。
- 仍阻断：供应商可见具名采购身份、正式发布的 SLA、真实本地采购路线、真实五阶段闭环。
- 当前共有 32 张 PO，其中 26 张活跃；活跃 PO 为本地 0、进口 0、未分类 26；阶段分布为 Supplier Commitment 3、Fulfilment / Production 23、Dispatch / Transit 0、Delivery / GRN 0。
- 真实验收 PO `po:7c4c2aa5-b119-4e14-8953-a9fc78882e2a` 的 Email Outbox 已 `dispatched`，当前阶段为 `supplier_commitment`；它仍没有 `odoo_purchase_order`、`supplier_confirmation`、`production_progress`、`shipment` 或 `grn`。因此它证明了真实外发，不证明 ERP 映射或五阶段闭环。

## 逐页视觉/交互验收 checklist（与 V1 对齐要求交叉核对）

以下清单用于实现后的逐页验收；“官网证据”表示本页已公开可见的基线，“实现验收”表示当前官网静态素材尚未证明、需要在产品中逐项验证的行为。核对依据为 `docs/NAVISIGHT-V1-ALIGNMENT.md` 的公开视觉基线与页面矩阵。

### 全局壳与导航

- [x] 淡灰工作区、白色圆角卡片、细边框、蓝色主动作，以及固定的风险状态色语义。
- [x] 左侧工作区/采购路线/报告/设置导航，顶栏搜索、通知、用户和页面筛选/日期动作。
- [x] 页面间对象 ID、返回路径和空态/加载态可追溯；官网当前只证实单页锚点导航，无产品应用壳。

### Overview / 产品总览

- [x] 保留官网 Overview 截图可见的 PO 总览、Current stage、Risk、AI summary 区块。
- [x] 展示 V1 要求的 6 个 KPI：High Risk、Overdue POs、Require Attention、Active Purchase Orders、Local Procurement、Import Procurement；趋势无两个真实快照时显示“待积累”。
- [x] PO 表具备 PO Number、Supplier、Route、Material Type、Current Stage、RIHD、Risk、Next Action 字段，并可按搜索、Route、Material Type、Stage、Risk、Supplier 筛选。
- [x] AI Procurement Summary 每条结论都有明确的 PO 或风险集合下钻入口；官网截图只证明摘要文案/数字存在，未证明可点击下钻。
- [x] Local / Import 圆环只计入有明确路线证据的 PO；币种金额不做无汇率依据的盲目相加。

### Notifications / 通知

- [x] 保持单一纵向事件队列，而不是三栏工作台。
- [x] 可见 All / Unread、未读徽标、Mark all read；每行包含严重度圆点、标题、类型 Badge、业务说明、相对时间和未读点。
- [x] 通知可打开关联 PO/风险对象并保留事件来源；官网的 `notifications.webp` 仅为静态 feed 截图，未证明筛选或已读写入。

### Drafted Emails / 草稿邮件

- [x] 左侧草稿队列、右侧完整邮件详情；可见 Pending / All 与 PENDING REVIEW。
- [x] 主动作固定为 `Approve & Send`，次动作 `Edit`、`Discard`；发送前显示 PO、供应商、物料、承诺日、沟通类别和持久化活动；官网未公开的连接器投递状态只在真实回执存在时显示。
- [x] 对齐官网 `drafted-emails.webp` 的“AI-written follow-up + one-click review/approval”视觉语法，但不把静态截图当成真实发送成功证据。

### PO Timeline / 采购订单详情

- [x] 固定呈现五阶段，不因数据缺失删除：PO Sent → Supplier Commitment → Fulfilment / Production → Dispatch / Transit → Delivery / GRN。
- [x] 每阶段具备图标、连接线、Completed / Active / Pending / Blocked 状态和阶段说明；官网 `po-timeline.webp` 可见前四阶段完成、Delivery / GRN pending 的静态基线。
- [x] 阶段事件、PO 行累计、证据、SLA、异常与审计均可展开查看；历史时间不精确时标为状态观察/历史时间未记录，不伪造迁移时间。
- [x] Supplier Commitment 人工核对可在同一弹窗查看真实入站邮件的主题、发件人、时间、Message-ID、证据 ID 与完整纯文本正文；PO 基准值只填充空白表单并保留人工差异，不自动提交或制造供应商事实。这是 Readywork 对真实闭环的追溯补强，不声称 Navisight 公开截图已证明相同内部实现。
- [x] Supplier Commitment 提交前可逐行预览数量、单价和交期差异，并独立显示是否命中后端审批规则；Web 与正式 SQLite 写路径共用核心领域合同，空输入和缺失 PO 基准保持待填写 / unknown，预检不持久化、不发信、不写 ERP。该行为用于落实 Navisight 公开文案中的 discrepancy immediately visible，不反向声称官网公开了相同阈值或内部算法。
- [x] 能从 Overview、Notifications、Drafted Emails、Local、Import、Risk Dashboard 双向打开同一 PO；官网尚未提供此交互证据。
- [x] 只读验收已覆盖正式业务对象 `po:7c4c2aa5-b119-4e14-8953-a9fc78882e2a`：阶段、当前风险、下一步和结构化 AI 动作均可追溯；官网 `PO-430089` 仅作为静态视觉参考，不写入正式库。消息时间线、外部发送与 ERP 回写仍只在真实连接器回执存在时标成功。

### Risk Dashboard / 风险看板

- [x] 保留官网 `risk-dashboard.webp` 的风险分布、供应商风险和在险金额视觉基线。
- [x] 展示 5 个 V1 KPI：High Risk PO %、High Risk POs、Medium Risk POs、Low Risk POs、At Risk Value。
- [x] 主图覆盖 Risk Score Distribution、Risk Breakdown、Risk by Supplier、Overdue Aging、Products Affected、Risk Trend。
- [x] Filters 与 Export 作用于真实快照及当前筛选结果；无汇率快照时按币种分开展示 At Risk Value。
- [x] 最高风险、供应商和受影响产品可下钻到真实供应商或 PO 对象；组合快照、供应商、账龄、产品与趋势上下文均来自不可变风险快照。官网截图只证明组合图表存在，未证明对象级下钻。
- [x] 2026-08-31 登录态 1280×720 复核：当前快照为 26 张 PO（9 高 / 1 中 / 16 低），上一快照为 8 高 / 1 中 / 17 低；按高风险筛选后显示 9/9 与 100%，清除后恢复 9/26 与 34.6%。“查看所有供应商”到真实供应商页，最高风险 `P00020` 到同一 PO 详情并能返回；全程无 alert。
- [x] 总览当前风险与持久化 Risk Dashboard 快照不一致时，后端返回可审计的新鲜度与当前只读计数，页面明确区分快照和当前组合；正式库已验证旧快照 9 个高风险、当前组合 13 个高风险。GET 不自动生成快照，只有显式“更新风险快照”才写入新审计点。

### Local / Import / Suppliers / SLA / Configuration

- [x] Local 与 Import 具备路线、阶段事件、ASN/Shipment、ETA、单证策略、GRN 等对应字段，且 PO 可打开详情；正式库无路线证据时显示 0 张并保留 26 张未分类 PO，不按供应商名称猜测。
- [x] Odoo PO 同步契约已覆盖 Incoterm、Incoterm location、目的地址与收货操作类型；路线候选优先使用版本化 PO Incoterm，其次使用版本化供应商地址，保存时重新校验引用。收货操作类型不作为路线证明，当前正式 Odoo 对应路线字段为空时仍保持未分类。
- [x] 合同 / Incoterm 人工路线证据必须先上传当前 PO 的真实文件并进入统一附件安全链；只有 ClamAV `clean` 且解析完成的当前版本候选可选。保存冻结证据记录版本、附件版本、SHA-256 与 PO 版本；自由文本编号、扫描中 / 隔离文件、类型错配和旧版本引用均被后端拒绝。
- [x] 已安全处理的当前 PO 附件可直接复用为路线证据，无需重复上传；绑定冻结附件版本和 SHA-256。采购经理可以带原因撤销错误证据，若当前 Local / Import 路线依赖该文件，后端在同一事务内退回 `unclassified` 并保留追加审计。
- [x] 2026-08-31 登录态复核 Local / Import 的官网四段环图、五个真实 KPI、执行阶段、已分类订单表、未分类队列和 Import 单证门禁。打开正式 `po:7c4c...` 的路线确认弹窗时，缺少证据引用会禁用“保存并记录审计”；验收只开启并关闭弹窗，未写路线。
- [x] Suppliers 页面能从供应商打开关联 PO，并展示沟通、承诺、SLA 与 GRN 证据；正式浏览器验收的 12 家供应商均因证据覆盖不足而不发布虚假总分。
- [x] SLA 页面显示版本化草稿、阶段进入事实、发布影响、匹配证据与评估历史；Configuration 显示 11 项后端统一 readiness、连接器健康、同步状态、安全事故和权限。
- [x] 2026-08-31 鉴权浏览器逐页复核 Local、Import、Suppliers、SLA、Advanced SLA 和 Configuration 的正常/真实空态；普通页面 URL 现持久化 `section`，直接打开、点击后刷新和前进/后退可恢复同一页面。

### FAQ / Demo / 表单

- [x] `/product` 的 FAQ 7 项使用原生 `details/summary`，保持可访问的折叠状态；答案按 Readywork 当前受监督 V1 门禁收紧，不复制未经本部署证明的绝对承诺。
- [x] Demo 表单保留官网字段、必填关系、ERP 与 Monthly PO volume 选项；成功只在真实 API 完成 SQLite 主记录与追加审计事务后显示，同键重放 / 冲突和非法输入均有后端语义。
- [x] 2026-09-01 官网已发布 `/privacy` 与 `/terms`。Readywork 已补充同构桌面公开路由并明确标注 Pre-release disclosure；内容只陈述当前可验证实现，运营主体、正式联系人、保留期、处理商、管辖和商用合同仍待法律审批。
- [x] 应用内浏览器已实际打开 `http://127.0.0.1:3001/product`，无需采购会话即可读取完整页面、FAQ 和表单。正式 SQLite 已加载 Migration 45 但 Demo 两表仍为 0；有效写路径由临时 SQLite 测试证明，不向正式库制造演示联系人。
- [x] 2026-08-31 重新读取官网现行视觉和公开图片资产后，本地 `/product` 已切换为 `#fafbfd / #f3f6fa / #0b1220` 冷灰海军蓝系统，并在 1280×720、1440×900、1920×1080 三档桌面视口复核。`overview-dashboard`、`notifications`、`ai-summary`、`drafted-emails`、`po-timeline`、`risk-dashboard`、`kpi-row`、`donut-local`、`donut-import` 均为真实加载的公开资产；未把截图中的静态数字写入 Readywork 业务事实。
- [x] V1 公开产品页不验收手机端。移动导航、小屏重排、抽屉和触控专用交互全部延后；该范围决定只影响视觉计划，不降低真实 API、SQLite、审计、连接器和五阶段闭环门槛。
