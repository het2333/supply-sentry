# Readywork × Navisight V1 对齐矩阵

> 本文是 `PROCUREMENT-V1-SCOPE.md` 的逐页验收附件。范围冲突时，以范围文件为准；页面是否完成，以本文的“真实数据 + 真实动作 + 持久化 + 刷新恢复 + 审计”五项证据为准。

## 1. 对齐原则

Readywork V1 对齐 Navisight 公开可验证的采购执行产品，不把未知页面、营销概念或截图中的静态数字冒充现有能力。

```text
PO Sent
→ Supplier Commitment
→ Fulfilment / Production
→ Dispatch / Transit
→ Delivery / GRN
```

发布口径：

- 业务能力对齐：五阶段状态、SLA、供应商沟通、风险、升级和人工决策必须真实运行。
- 信息架构对齐：采用 Overview、Notifications、Drafted Emails、Local、Import、Risk Dashboard、Suppliers、SLA、Configuration。
- 视觉对齐：只对公开截图中可验证的布局、间距、卡片、表格、色彩和状态语法做高保真对齐。
- 系统事实优先：所有指标、列表、状态、动作和时间线来自 API 与 SQLite；禁止前端 Mock、写死统计、localStorage 业务状态和假成功。
- 正式空态不可填充：API 启动不再在空数据库中注入 RFQ、PO、供应商邮件、发票、异常或审批样例；不存在的业务事实必须保持 0 / 空列表。合成事件入口和员工页硬编码“运行测试”动作已从生产 Web / API / 聊天工具面删除。
- 外部副作用诚实：邮件、WhatsApp、Odoo/WMS 回写只有在连接器明确成功后才显示成功。
- 供应商可见身份真实：外发必须冻结租户级具名采购联系人、职位和企业；未配置时禁止生成、批准和发送，不向供应商暴露 Readywork / AI 标识。
- 人在回路：AI 可提取、判断、生成草稿和推荐；差异、高风险与超权限动作交给人批准或覆盖。

### 公开产品页桌面对齐（2026-08-31）

- `/product` 已完成 Hero、连接系统带、Problem、Gap、Solution、五阶段、Risk visibility、Customer value、Why us、7 项 FAQ、真实 Demo 申请和 Employee Pack 标准区。Hero 次 CTA 留在公开页并定位 `#solution`；顶栏按官网保持全宽 sticky，所有页内锚点均停在顶栏下方约 80px。Problem 已收口为“ERP → 虚线分流 → Email / WhatsApp / WeChat / Phone calls / Spreadsheets 五通道”；Gap 已收口为官网 2×2 风险信号带与右侧产品图；How it works 已收口为五个编号圆点、横向连接线和下方真实 PO 双栏说明。
- 页面使用 1360px 主内容宽度与桌面双/三列视觉骨架；V1 只验收 1280px 及以上的桌面 Web。1280×720、1440×900、1920×1080 实页均确认顶栏 `top=0`、目标 section `top≈80`、五通道完整且页面无水平溢出。用户明确将手机端延后，所以移动导航、小屏重排与手机视觉不计入当前完成状态，也不得阻塞 V1。
- 营销页只有 Demo 表单是写动作；它继续使用严格校验、幂等键、SQLite 单事务和追加审计，不自动发邮件、写 CRM/Odoo 或启动采购流程。
- 公开页完成不改写业务 readiness；具名身份、正式 SLA、真实路线和五阶段闭环仍按正式库证据判定。

## 2. V1 页面地图

| Navisight 页面 | Readywork 页面 | V1 目的 | 发布级数据合同 | 发布级动作 | 当前状态 |
|---|---|---|---|---|---|
| Overview | 总览 | 一眼识别高风险、逾期、需关注和活跃 PO | 当前 PO 组合、风险快照、RIHD、路线、阶段、供应商 | 搜索、筛选、打开 PO、保存幂等风险快照 | 公开截图主结构已完成桌面视觉复核；真实 PO 行、AI 摘要集合、高风险筛选和 PO 深链均已对象级下钻，待真实闭环后验收 |
| Notifications | 通知 | 集中查看升级、无回复、SLA 违约、RIHD 风险和 GRN | 持久化通知、业务指纹、已读版本、关联对象 | 打开对象、单条已读、全部已读 | 公开单列通知骨架已完成桌面视觉复核；真实事件、未读版本、严重度、对象深链与批量已读已接入，待真实闭环产生完整五阶段事件验收 |
| Drafted Emails | 沟通草稿 | 审核 AI 生成的供应商沟通 | PO、联系人、SLA 命中、具名发件身份快照、邮件正文、版本、事件、Outbox | 编辑、批准并入队、丢弃、打开关联 PO；真实发送后更新 sent | 公开双栏骨架已完成桌面视觉复核；真实队列/详情、状态、编辑、审计、专业联系人门禁、SMTP 具名发件、邮箱健康、provider 限流退避与 PO 深链已对齐，待正式 SLA 与真实回信闭环验收 |
| Local | 本地采购 | 管理本地 PO 的五阶段和到货 | 明确路线、PO 行、阶段事件、ASN、GRN、SLA | 打开具体 PO、核验事实、处理异常 | 公开风险圆环、KPI、筛选表格和路线空态已完成桌面视觉复核；Shipment 批次、承运商、运单、ETA 与收货次数读取真实聚合。路线确认已要求结构化证据并阻断有进口事实的降级；正式库仍无已分类路线，保持 0 张诚实空态，尚无真实 GRN |
| Import | 进口采购 | 管理发运、在途、清关、单证和到货 | 进口路线、Shipment、ETA、运输节点、单证策略、GRN | 打开具体 PO、核验运输 / 清关节点、上传/绑定单证、校验、处理异常 | 公开风险圆环、KPI、筛选表格、进口空态与单证区已完成桌面视觉复核；Shipment ETA、不可变 Transport Event、清关状态和单证读取同一真实路线模型。正式库仍缺进口路线、Shipment、运输节点、清关事实及真实单证闭环 |
| Risk Dashboard | 风险看板 | 解释风险来源、金额、供应商、账龄、产品和趋势 | 不可变风险快照、PO 证据、币种金额、时间范围 | 日期筛选、组合筛选、导出、打开风险对象 | 公开截图主结构已完成桌面视觉复核；真实筛选、CSV 导出、幂等快照刷新和 PO 对象级下钻已完成，待真实闭环后验收 |
| Suppliers | 供应商 | 查看供应商响应与交付表现 | 主数据、Operating Profile、联系人、PO、沟通、承诺、SLA、GRN | 搜索/筛选、同步 ERP、登记/编辑档案、管理制造交期、按 supplierId 打开 PO、停用/启用 | 十列目录、完整 More 菜单、真实 Add/Edit/Deactivate/Reactivate API、双版本、Odoo 权威字段保护、supplierId-only PO 关联和追加事件已落地；隔离 API/SQLite/DOM 验收通过。真实 Chrome 三视口与参考平台逐项复验仍因扩展控制通道不可用而未签字，不冒充百分百完成 |
| SLA | SLA | 定义每阶段检查、跟进、宽限和升级 | 版本化策略、阶段进入事实、匹配证据、评估历史 | 编辑、发布、退役、重评 | 七列目录、精确 Applies To/Status、七字段 Add/Edit、折叠 Advanced、键盘/焦点契约以及真实 API/SQLite Draft v2 刷新恢复均已落地；隔离 API、持久化、视觉边界、DOM 交互和全仓验证通过。正式建议策略仍未发布；真实 Chrome 已核对参考字段和本地刷新态，但三视口下 empty/draft/published/403/409/runtime-disabled 的完整点击矩阵因扩展控制通道中断尚未签字，不冒充百分百完成 |
| Advanced SLA | Advanced SLA 独立导航与页面；PO Intake 保留为 Configuration 深链 | 按 section、manual 或 CSV 管理更细的运营规则与自动发送策略 | 9 域版本化 profile、CSV batch/diff、精确 candidate impact、runtime control/event、readiness 与审计 | 导入/编辑/发布/退役、应用/丢弃 CSV 预览、启停 kill switch | 代码、隔离验收与鉴权浏览器验收已收口：待应用前显示精确 batch/profile/candidate 版本及真实 PO 影响，旧 v38 重启修复与并发启动通过；正式库无 profile 时保持 9 域真实空态 |
| Configuration | 设置与连接 | 确认邮箱、ERP、WhatsApp、具名采购联系人、路线和权限是否可运行 | 加密凭据、版本化沟通身份、健康状态、同步状态、安全事件、角色 | 保存专业联系人、测试连接、只读同步、策略配置、安全告警处置/接受风险 | 发布门槛控制面已收口：`GET /api/operations/v1-readiness` 在后端统一核验 11 项租户事实；首屏三通道面板继续从同一 Connector/凭据合同派生，当前 Email 与 Odoo 已验证、WhatsApp 未配置。沟通身份仍未配置、SLA 未发布、21 个安全事故未处置、26 张活跃 PO 路线未分类、真实五阶段闭环为 0，所以最新正式状态仍是 `blocked · 6/11` |
| PO Timeline | 采购订单详情 | 解释一张 PO 当前在哪里、为什么、下一步是什么 | 不可变五阶段事件、PO 行累计、Production Progress、Shipment、Transport Event、证据、SLA、异常、审计 | 草稿跟进、差异审批、生产 / 备货进度、ASN/GRN 与运输节点核验、打开证据 | Overview / Items / Supplier / Documents / History / Communication 六页签已按 Navisight 公开合同归位；旧深链、PO + 页签原子 URL 恢复、单实例详情、未知值、Shipment/Receipt 身份、真实 SLA rule、通信排序、错误态与桌面键盘/焦点契约已收口。真实 P00021 已完成三个桌面视口的 Overview / 五阶段 / 制造上下文折叠验收；生产、发运、GRN 和正式真实 PO 全链仍待完成 |

## 3. 公开视觉基线

精确颜色、字体、圆角、阴影、侧栏尺寸、页面留白和当前差距见 [`NAVISIGHT-VISUAL-TOKENS.md`](./NAVISIGHT-VISUAL-TOKENS.md)；公开应用静态 API 合同与 Advanced SLA 九域见 [`NAVISIGHT-PUBLIC-APP-CONTRACT.md`](./NAVISIGHT-PUBLIC-APP-CONTRACT.md)。

### 全局应用壳

- 左侧导航分为主工作区、采购路线、报告和设置。
- 顶栏包含搜索、通知、当前用户和页面相关日期/筛选动作。
- 淡灰工作区、白色圆角卡片、细边框、蓝色主动作、紧凑但可读的表格。
- 每个状态颜色具有固定语义；不能用装饰性颜色覆盖业务风险含义。

### Overview

- 6 个 KPI：High Risk、Overdue POs、Require Attention、Active Purchase Orders、Local Procurement、Import Procurement。
- 桌面断点固定为：1280px 使用 3×2 KPI 保证每张卡可读；1440px 与 1920px 使用 6 张单行，保持 PO 表和 AI Procurement Summary 尽早进入首屏。当前 V1 不实现手机 KPI 重排。
- KPI 趋势只能来自至少两个真实快照；证据不足时显示“待积累”，不画假曲线。
- PO 表字段：PO Number、Supplier、Route、Material Type、Current Stage、RIHD、Risk、Next Action。
- 支持搜索及 Route、Material Type、Stage、Risk、Supplier 筛选。
- AI Procurement Summary 的每条结论可跳转到对应 PO 或风险集合。
- Local / Import 风险圆环只统计有明确路线证据的 PO。

### Notifications

- 单一纵向事件队列，不改成三栏工作台。
- 保留 All / Unread、未读徽标、Mark all read。
- 每行包含严重度圆点、标题、类型 Badge、业务说明、相对时间和未读点。

### Drafted Emails

- 左侧草稿队列，右侧完整邮件详情。
- Pending / All 与 PENDING REVIEW 状态清晰可见。
- 主动作固定为 Approve & Send；次动作为 Edit、Discard。
- 邮件详情必须包含 PO、供应商、物料、RIHD、关联 SLA/风险和持久化活动。

### PO Timeline

- 固定呈现五个阶段，不因数据缺失删掉阶段。
- 每阶段有图标、连接线、Completed / Active / Pending 和阶段说明。
- 历史时间不精确时标明 observed/backfill，不伪造迁移时间。

### Risk Dashboard

- 5 个 KPI：High Risk PO %、High Risk POs、Medium Risk POs、Low Risk POs、At Risk Value。
- 主图包括 Risk Score Distribution、Risk Breakdown、Risk by Supplier、Overdue Aging、Products Affected、Risk Trend。
- 在没有汇率快照时按币种分开展示在险金额，禁止盲目相加。
- Filters 与 Export 必须作用于真实快照和当前筛选结果。

## 4. 五阶段发布验收矩阵

| 阶段 | 进入事实 | 完成事实 | 自动工作 | 人工门禁 | 必须保留的证据 |
|---|---|---|---|---|---|
| PO Sent | 已批准 PO 待发送或 ERP 已发出状态 | 邮件/ERP 连接器明确成功，或可信 ERP 状态观察 | 冻结版本、附件与具名发件身份、创建 Outbox、重试 | 无合法联系人、无专业沟通身份、附件未通过安全检查或连接器未就绪时阻断 | PO 版本、身份版本/快照、附件哈希、Connector 回执、SMTP From / Message-ID、审计 |
| Supplier Commitment | PO 已真实发出 | 可信供应商回复确认全部 PO 行；差异经审批 | IMAP 关联、发件人验证、结构化提取、SLA 重算 | 价格/数量/交期差异必须人工决定 | 原始邮件、线程头、供应商身份、逐行确认、审批 |
| Fulfilment / Production | 承诺已接受 | 全部有效行达到可发运状态；部分履约不提前完成 | 进度检查、无回复跟进、RIHD 风险预警 | 变更承诺、短交或重大延迟需要审批 | 生产/备货更新、承诺日期、数量事实、规则命中 |
| Dispatch / Transit | 首笔合法 ASN/Shipment | 全部有效行发运完成；部分发运保持 active | ETA/运输节点检查、延迟跟进 | 人工 ASN 只能记为 manual_verified；进口单证不全阻断 | ASN、承运商、运单、批次/行数量、ETA、来源类型 |
| Delivery / GRN | 首笔合法收货 | ERP/WMS GRN 与全部有效行数量闭合 | 到货异常、数量差异和逾期通知 | 人工 GRN 需要审批与核验理由；进口最终 GRN 经过单证门禁 | ERP/WMS 回执、GRN、逐行数量、单证校验、审计 |

## 5. V1 发布门槛

以下条件必须同时满足，不能用测试或演练替代：

1. 选定一张真实本地 PO，登记明确路线和真实供应商联系人。
2. 采购经理配置并确认真实的具名采购联系人、职位和公司，同时审批并发布适用 SLA 策略。
3. PO 真实发送后才进入 `PO Sent completed`，并保存外部 Message-ID/回执。
4. 真实供应商以结构化回复确认；任一差异进入人工审批。
5. Fulfilment 检查、至少一次部分发运和部分到货均能刷新恢复且不重复计数。
6. 最终 Odoo/WMS GRN 与 PO 行闭合，五阶段全部完成。
7. Overview、Notifications、Drafted Emails、Local 和 Risk Dashboard 同步反映同一笔真实采购。
8. 所有外部动作、人工覆盖、失败、重试和状态迁移可在统一审计链追溯。
9. 重启 Web、API 和 Worker 后，任务、草稿、Outbox、阶段、通知和审计不丢失、不重复发送。
10. 生产死信为 0；Temporal、ClamAV、Odoo/邮箱连接器健康；安全告警已处置或明确接受风险。

## 6. 冻结优先级

### P0：V1 发布阻断

1. 真实本地 PO 全闭环。
2. 正式 SLA 发布与阶段时钟验收。
3. 真实供应商回信、差异审批、部分发运与最终 Odoo GRN。
4. Overview、Notifications、Drafted Emails、Local 和 PO Timeline 的同源联动。
5. 重启恢复、幂等、超时重试、死信、连接器隔离和安全监控。

### P1：V1 完整性

1. Import 的真实运输节点、清关事实和真实单证闭环；Shipment ETA 代码纵切已完成，仍待真实业务证据。
2. Risk Dashboard 的公开截图最终视觉精度。
3. Suppliers、SLA、Configuration 的逐页视觉与错误/空状态验收。

### V1 后

- 采购需求、寻源、RFQ、报价比较、定标与 PO Draft。
- 发票、三单匹配、应付审批和付款。
- Teams Bot、供应商门户、合同全生命周期和更广泛 Source-to-Pay。

这些模块可以保留在平台中，但不进入 Navisight 对齐 V1 的完成百分比。

## 7. 完成定义

页面只有同时满足以下条件才能标记为完成：

- `Data`：只读真实 API/SQLite，空状态也准确。
- `Action`：按钮调用真实业务动作，并等待真实结果。
- `Persistence`：刷新、重启和多会话后状态一致。
- `Safety`：权限、版本、幂等、附件安全、连接器门禁有效。
- `Audit`：原始证据、AI 判断、人工决定和副作用结果可追溯。
- `Visual`：与 Navisight 公开截图逐项比对，桌面主视口无明显结构偏差。
- `Verification`：定向测试、TypeScript、生产构建和浏览器正常/空/错误状态均通过。

在真实 PO 从发送走到最终 GRN 前，V1 状态统一为“待验收”，不得标记为“已上线”。

## 8. 视觉与工程基线记录

2026-08-28 已将 Navisight 固化为 V1 唯一公开视觉基线，并完成以下复核：

- `2048×1152`：Overview 与 Risk Dashboard 的集成式页头、KPI、表格/摘要、风险分布、风险分解和供应商 Top 10 与公开截图逐项比对。
- 默认桌面视口：全局页头改回流式布局，日期、搜索、通知和用户区域无重叠；主要卡片按断点降列。
- Overview：六项 KPI、真实 PO 表、AI 摘要、高风险集合下钻与 Local / Import 风险概览均读取真实 API；路线证据缺失时保留诚实提示和零值。
- Local / Import：依据 Navisight 公开的两张路线风险卡，统一为白色分隔、圆角端点、中央“按计划”数量与右侧“数量 + 百分比”图例；总览与两个路线页共用同一组件。路线页页头、五张 KPI、五阶段、PO 表和搜索 / 阶段 / 风险筛选均读取 `/api/procurement/workbench`；过滤不制造业务事实。浏览器已验证正式库 Local / Import 均为 0，26 张 PO 保持未分类，进口单证策略未发布，未提交路线确认或任何外部副作用。浏览器控制台 0 error / warning；路线、工作台与风险定向测试 `13/13`、全量 `329/329`、TypeScript 与 Console 生产构建通过。独立 Local / Import 内页没有公开完整截图，因此只声称公开视觉语法对齐，不声称未知布局的像素级复刻。
- Suppliers：Navisight 公开资料只确认了独立 Suppliers 导航，没有公开完整内页截图；页面因此复用已验证的页头、五张 KPI、紧凑筛选表和右侧证据详情语法，不声称未知布局的像素级复刻。当前正式快照包含 12 家供应商，0 家达到发布总分门槛，11 家因高风险 PO 等证据进入风险集合，平均证据覆盖 27.5%。页面不再把单一维度的 75 / 100 或 100 / 100 冒充正式供应商总分；未达 45% 门槛时列表与详情均显示“总分未发布”，同时保留“3/4 张 PO 已取得承诺”等可追溯维度事实。主数据 API 增加 `sourceSystem / externalId`，浏览器已验证手工登记与本地 Odoo 来源、关联 PO 深链和空证据状态；控制台 0 error / warning。供应商 / RFQ 定向测试 `16/16`、全量 `329/329`、TypeScript 与 Console 生产构建通过；未同步 ERP、未登记供应商、未刷新正式快照。
- Risk Dashboard：五项 KPI、多币种在险金额、持久化快照水位、筛选、导出和 PO 下钻均为真实数据合同；快照刷新已在浏览器中验证持久化历史点增长。
- Notifications：`2048×1152` 下完成单一页面标题、All / Unread、批量已读、严重度事件行和对象未读点视觉复核；列表来自持久化通知 API。
- Drafted Emails：`2048×1152` 下完成 Pending / All、草稿队列、邮件正文、PO 上下文、Approve / Edit / Discard 和审计时间线视觉复核；连接状态和按钮均使用真实邮箱、SLA、Outbox 合同。
- 浏览器控制台无 error；TypeScript 与 Console 生产构建通过；加入生产 / 备货进度纵切后，完整套件以串行隔离模式通过 `323/323`。默认并发模式曾受本地运行中 Odoo/连接器资源竞争影响，失败用例单独与串行全量重跑均通过。
- `P00021` 真实浏览器复验通过：PO 行显示 Supplier Commitment、高风险和获取供应商确认；详情明确结构化确认尚未覆盖全部 PO 行；五阶段只有一个 `In progress`；Fulfilment、Dispatch 和 Delivery 均为 `Pending`；供应商承诺完成前不显示发运或收货动作。对应工作台、IMAP 与沟通草稿定向测试 `27/27`、全仓 TypeScript 和 Console 生产构建均通过。
- Shipment ETA 纵切已完成：`estimatedArrivalAt` 进入核心模型、写入事务、两个发运阶段事件证据、工作台摘要与采购路线聚合；人工 ASN 表单按浏览器时区录入并保存 ISO 时间，相关文件页展示承运商、运单与 ETA。浏览器已验证 `P00001` 的真实 ASN 核验弹窗包含 ETA 字段，随后取消，未提交发运事实；Local 正式空态展示运输 / ETA 列且 26 张未分类 PO 仍未被猜测归类。执行与工作台 API 定向测试 `12/12`、全仓 TypeScript、Console 生产构建和浏览器控制台均通过。
- 运输节点 / 清关事实纵切已完成代码对齐：`TransportEvent` 进入核心模型和不可变采购文档，支持揽收、离港、到港、清关申报 / 放行 / 受阻、派送、承运商送达和异常；写入必须绑定真实 Shipment、校验实际时间与唯一证据编号，并保存位置、承运商参考、最新 ETA、原始核验依据、核验人和原因。清关节点只允许明确进口路线，`customs_held` / `exception` 联动风险与通知，承运商 `delivered` 不替代 GRN。
- Import 浏览器验收读取正式 SQLite：活跃进口 PO 为 0，26 张 PO 全部保持路线未分类；订单表已呈现“运输事实”和“ETA / 清关 / 单证”列，正式策略显示未发布，未创建任何 Shipment、Transport Event、路线确认或外部副作用。页面控制台无 error / warning；执行、工作台和通知定向测试 `13/13`、全仓 TypeScript、Console 生产构建通过。
- Fulfilment / Production 纵切已完成代码对齐：`ProductionProgress` 与 `ProductionProgressLine` 进入核心模型、SQLite 文档/行和采购执行事务；写入要求审批权限、唯一证据编号、原始核验依据与原因，行级完成数量不得超过有效订购量，完成度限定为 0–100，延期 / 受阻必须说明原因。最新行级事实驱动阶段，只有全部有效行 100% 且 `ready_to_ship` 才完成 Fulfilment；部分发运 PO 不会被状态回退。工作台文档、时间线、组合风险、风险快照和持久化通知均已接入。执行、工作台、通知与风险定向测试 `14/14`、全仓 TypeScript 和 Console 生产构建通过；正式 SQLite 当前 `productionProgress=0`，未制造供应商生产事实，浏览器正式空态仍待用户手动刷新后复验。
- PO Evidence / Documents 纵切已补齐真实附件读取和安全阅读：工作台上下文除单据 JSON 快照外，还按租户查询 `procurement_attachments.owner_id / requisition_id`，覆盖邮箱 PO Intake 与进口单证落库文件；只有 ClamAV `clean` 文件返回内容 URL，等待扫描与隔离文件只显示事实。PO 文档页同源图片 / PDF 可内嵌，外部 URL 只允许显式安全打开，凭据 URL、协议相对 URL 和未知安全状态不自动加载。正式 API 已读到一份 `clean / parsed` 的真实 PO 附件；定向 `11/11`、全量 `323/323`、TypeScript 与 Console 生产构建通过，浏览器视觉复验仍等待用户刷新当前本地标签页。
- 本条的早期视觉判断已由第 43 节更新：现已从 Navisight 公开静态包的 `function r6()` 验证完整 SLA 桌面主骨架，不再沿用“未公开完整 SLA 内页”的结论。原有安全合同继续保留：未保存编辑会锁住发布，确认弹窗只引用已保存策略版本和规则数量；退役要求 `configure + approve` 双权限、`expectedVersion` 乐观锁与二次确认，且只清除当前评估投影，不删除策略、评估事件、沟通或审计历史。正式 v2 草稿仍匹配 26 张活跃 PO，其中 24 张可评估、2 张缺期限证据；正式策略、评估与外发副作用仍保持 0，未发布、未退役、未发送、未回写 ERP。
- 专业采购沟通身份纵切已完成：Migration 33 安装租户级身份与追加事件，GET / PUT API 使用配置权限、乐观锁和租户隔离；SLA 草稿、PO 工作台跟进、PO / RFQ Outbox 均冻结同一身份，SMTP `From` 采用 RFC 2047 UTF-8 具名显示，发信包络仍使用真实邮箱；缺身份或旧草稿无快照时全程阻断。身份首次保存时只会重绑“未编辑 + 未批准 + 精确带旧 Readywork 签名”的 SLA 草稿，替换正文签名、冻结身份快照并追加 `identity_rebound` 审计；人工编辑或已处理内容不改写。正式库身份与事件均为 0，3 份旧草稿已验证全部符合安全重绑条件，但在用户确认真实姓名/公司前仍未修改、未批准、未发送。
- 本纵切的身份、草稿、Outbox、入站回信、SLA 自动化、SMTP 与持久化定向测试 `70/70`；全仓 `329/329`、TypeScript、Console 生产构建通过。
- V1 运行时已切换到 Readywork 独立 Temporal：Docker 健康、Cluster `SERVING`、Task Queue 有 1 个 Poller，控制面 `workerReady=true`；Compose 停止并重启后同一 SQLite 持久卷与 Worker Poller 恢复成功。当前整体状态仍为 `degraded`，42 条原始安全事件中有 7 条仍未处置；事件未被删除或自动接受风险。
- V1 发布就绪纵切已完成：新增控制面只读接口 `GET /api/operations/v1-readiness`，由后端统一计算供应商可见身份、正式 SLA、SMTP、IMAP、Odoo、ClamAV/附件门禁、Temporal/死信/副作用、安全告警、本地 PO 和真实五阶段闭环共 10 个门槛。五阶段闭环只接受每阶段 `exactTransitionTime=true` 且非 migration/document snapshot 的完成事件，并要求最终 Delivery / GRN 具有 `odoo_grn` / `wms_grn` 回执；历史观察状态不能冒充闭环。Configuration 首屏已经显示真实 KPI、完成度、全部门槛证据和修复深链。正式 API 当前为 `blocked · 4/10`：SMTP、Odoo、ClamAV 和 Temporal 就绪；旧 UID 的 24 小时 IMAP 限流退避已恢复，专业采购身份、正式 SLA、7 条未处置安全事件、本地 PO 路线和五阶段闭环仍阻断。定向测试 `2/2`、全仓 TypeScript 与 Console 生产构建通过，浏览器已验证 26 张活跃 PO、0 张本地、26 张未分类、0 个闭环及当前退避恢复事实；未保存身份、未发布 SLA、未接受安全风险、未分配路线、未发送邮件或回写 ERP。
- 内部 Readywork PO Draft → 人工批准 → ERP Outbox → Odoo `po.create_draft` 真实纵切已补齐：入队时冻结 PO 版本、供应商、币种与逐行数量/单价；派发前按 correlation 幂等查重，连接器回读真实 Odoo `name`，随后在同一事务保存不可伪造的 `odooReference`。Web 任务详情已显示 Readywork 与 Odoo 的映射与审计结果。该纵切尚未触发真实 Odoo，不构成真实五阶段闭环或发布状态变更；定向及全量测试 `341/341`、TypeScript 与 Console 生产构建通过。
- PO 阶段完成态文案已与真实证据收口：`po_sent` 是“PO 发出”工作阶段，不再统一显示为“PO 已发送”。Odoo `draft` 的队列、筛选和详情标题均显示“PO 发出 / PO Draft 已就绪，等待发送”；只有 SMTP 连接器成功事件才推进到 Supplier Commitment 并出现“已发送”业务事实。浏览器已用正式库 `P00022` 复核真实 Odoo 单号、310 Units、草稿判断和发送门禁；未点击批准或发送。全量串行测试 `342/342`、TypeScript 与 Console 生产构建通过。
- PO 队列筛选计数已改为与列表共用同一份 `QueueItem` 分类，不再拿包含 runtime task 的全局 operations 指标冒充 PO 行数。正式库浏览器复核为全部 32、正在执行 6、等待外部 26，并与页面分组 `(6)/(26)` 精确一致；搜索和风险筛选只缩小可见行，不篡改原始分组总数。
- RFQ/Odoo 供应商同步并发测试已移除调度时序假设：第二个同键请求既可以在首次提交前参与连接器读取，也可以在首次提交后直接重放冻结响应；两种路径都继续强制单一供应商版本、载荷冲突检测和租户隔离。默认并行全量测试及串行全量测试均为 `342/342`。
- 采购订单深链已补齐业务编号解析：`?section=orders&poId=P00022` 现在会在真实工作集内按内部 ID、`displayNumber`、`number`、`externalId` 精确解析，再规范化为持久化 PO ID；不会先误报“订单不存在”或在切换“阶段进度”等标签后漂移到相邻 PO。浏览器以真实 Odoo `P00022` 验证：详情保持 `P00022 · PO 发出`、五阶段 Timeline 可读、URL 规范化为 `purchase-order:odoo:22`，且未触发批准、发信或 Odoo 写入。同期重新对照 Navisight 官方 `po-timeline.webp`、`drafted-emails.webp` 和 `notifications.webp`；当前五阶段纵向状态、草稿双栏审核和通知单列结构继续成立。全仓 TypeScript 与 Console production build 通过。
- 采购路线确认已从自由文本升级为结构化证据：合同、Incoterm、ERP 字段或人工复核均必须提供可追溯引用，可选补充说明随 PO 状态/版本快照进入 `evidence_json` 和追加式路线事件；页面继续使用真实 API、权限与乐观锁。当前路线为进口且已存在 Shipment、Transport Event、进口单证绑定或已发布进口单证门禁时，直接改成本地返回 `409 IMPORT_ROUTE_DOWNGRADE_BLOCKED`，避免通过路线降级绕过进口 GRN 门禁。本轮浏览器只打开了正式库第一张未分类 PO 的确认弹窗，确认四类结构化字段和保存按钮在缺证据时禁用，随后取消，未提交路线、未调用 Odoo/SMTP。
- Risk Dashboard 的趋势组件不再在 0 个历史点时构造虚拟 0 分。少于 2 个真实持久化快照时改为明确空态，并在仅有 1 个点时只显示当前评分与日期；2 个及以上快照才绘制折线。正式库当前已有 2 个真实快照，因此正常显示真实趋势。
- 2026-08-28 本纵切完成后，路线与风险定向测试 `2/2`、全量测试 `344/344`、全仓 TypeScript 与 Console production build 均通过；Business API 已使用工作区 Node 24 运行时重启加载新路线契约，浏览器控制台 0 error / warning。正式 readiness 事实未被改写，仍为 `blocked · 4/10`，26 张活跃 PO 仍全部未分类，真实五阶段闭环仍为 0。

## 9. 2026-08-30 公开应用与仓库差距复核

- Navisight 的公开证据边界已从“官网单页 + 静态截图”扩展为“官网单页 + 10 个截图资产 + `app.navisight.ai` 登录页 + 可公开读取的前端静态信息架构”。公开静态包可验证 Overview、Notifications、Drafted Emails、Local、Import、Risk Dashboard、Suppliers、SLA、Advanced SLA 与 Configuration；登录后动作是否真实执行仍不得从静态代码推断。
- Readywork 采购执行主导航现与公开信息架构保持 10 个顶层入口，已补齐独立 Advanced SLA；PO Intake 的安全能力未删除，而是保留为 Configuration / Inbox 深链。`apps/console/app/page.tsx` 仍接受历史 `section`，其中 Overview / Org / Employees / Tasks / Approvals / Context / Tools 等旧工作区不进入采购执行主导航。
- 隐藏历史 `quote` / `evals` 生产面已收口：硬编码客户、产品、价格、毛利和无效“批准并发送”渲染已从生产树删除，缺证据时回退为 0 的 KPI 表也已删除。版本化浏览器历史若仍携带 `quote` 会迁移到读取真实 RFQ / SQLite 的“寻源与询价”，`evals` 会迁移到真实采购总览；两者均不再属于可渲染 Section。迁移决策由独立强类型导航模块统一处理，未知或畸形状态继续 fail closed。
- Navisight 公开应用的若干 API 在无登录会话时返回 HTTP 200。Readywork 将其视为反向安全证据：生产模式必须默认拒绝、租户隔离、对象级授权、脱敏和不可变审计；本地 `READYWORK_DEMO_AUTH=1` 只能用于本机验收，不能成为发布配置。
- 当前正式 V1 readiness 已增加 Manufacturing Context/Twin 门禁，实时结果为 `blocked · 6/11`。就绪项为 SMTP、IMAP、Odoo、ClamAV、Temporal 和 Context/Twin；阻断项仍是具名采购身份、正式 SLA、7 个未处置安全事故、本地路线与真实五阶段闭环。

上述记录只冻结页面与工程基线，不替代第 5 节的真实 PO 全闭环发布门槛。

## 10. 2026-08-30 Advanced SLA Task 5 接受证据

- 精确 API 路由：`GET /api/procurement/advanced-sla`、`POST /api/procurement/advanced-sla/profiles`、`PATCH /api/procurement/advanced-sla/profiles/:id`、`POST /api/procurement/advanced-sla/profiles/:id/publish`、`POST /api/procurement/advanced-sla/profiles/:id/retire`、`PUT /api/procurement/advanced-sla/runtime-control`、`POST /api/procurement/advanced-sla/imports/preview`、`POST /api/procurement/advanced-sla/imports/:id/apply`。CSV 预览在应用前显示并保留 `candidateType/candidateId/candidateVersion/profileId/profileVersion` 与活跃/匹配 PO 计数；apply 同时关联这组精确身份。应用、刷新、丢弃、profile ID/版本变化或预览错误都会清除待定预览。
- 精确 SQLite 表：`procurement_advanced_sla_profiles`、`procurement_advanced_sla_profile_events`、`procurement_advanced_sla_runtime_controls`、`procurement_advanced_sla_runtime_events`、`procurement_advanced_sla_import_batches`。已记录 migration 38 的旧 schema 升级时，runtime control 从同 tenant 引用的持久化 profile 重建精确版本；runtime event 仅从自身 `detail_json.profileVersion` 或同 tenant/profile 的不可变发布事件恢复，无可重建证据时保留 SQL `NULL` 并在读模型显示 `profileVersionBinding=legacy_unknown`，不伪造 0/1。缺列检查、加列与证据回填整体在 `BEGIN IMMEDIATE` 内串行并重新检查；普通迁移也在取得该锁后重检 version/name。同名并发已完成则安全跳过，name conflict 或其他 SQL 错误仍回滚并抛出。
- 可复核命令与结果（均 exit 0）：定向 API/automation/message-draft/Outbox `39/39`；Console `23/23`；Persistence `9/9`；`pnpm test` `491/491`；`pnpm typecheck`；`pnpm --filter @readywork/app-console build`（Next.js 16.3.3，`/` 与 `/_not-found` 静态生成）。所有变更型验收只使用 `:memory:`/临时 SQLite 与 fake/local connector 边界；未更改 `data/readywork.sqlite`，未发布真实 auto-send 策略，未调用 Odoo，未发送 Email/WhatsApp，也未停止或重启运行中服务。
- 剩余门槛：控制器已记录 3001/4173/4174 health 为 HTTP 200，但内置浏览器 URL 策略拒绝控制已打开的 `127.0.0.1:3001` tab，因此本轮没有生成新的鉴权截图，正常/空/错误/无权限/连接器未就绪/kill-switch 浏览器验收仍待用户重载并登录或使用策略允许的本地浏览器路径。不将完整 Navisight 目标标记完成；PO 详情六页签及其他公开页面差距仍需分别验证。应用壳与共享视觉令牌已在第 12 节完成工程收口。

## 11. 2026-08-30 生产导航诚实性收口

- `apps/console/features/procurement/navigation-state.ts` 现在只暴露真实生产 Section，并对两项退休状态做确定性迁移：`quote → sourcing`、`evals → home`。生产源码与构建产物不再包含原来的硬编码客户/RFQ 示例。
- 新增导航回归测试覆盖全部合法 Section 保真、两项退休迁移以及未知/畸形状态拒绝，结果 `3/3`；全仓 `pnpm typecheck` 与 Next.js 16.3.3 production build 均 exit 0。
- 本地 Console、Business API、Control API 已使用工作区 Node 24 恢复，HTTP 验证均为 200；启动前后 Outbox 均只有 4 条历史 `dispatched` 记录，没有 queued/retry/ready 项，因此本轮没有新增邮件、Odoo 写回或其他外部副作用。
- 内置浏览器仍因本地 URL 安全策略拒绝刷新已打开标签；未绕过、未切换其他浏览器表面。用户手动刷新并登录后的视觉验收仍是独立门槛。

## 12. 2026-08-30 应用壳、视觉令牌与旧复审阻断复核

- Advanced SLA 当前源码已消费 CSV preview 响应中的精确 `impactPreview`，页脚优先呈现 pending import candidate；旧 migration 38 的 runtime control/event 版本只从同租户 profile、事件自身证据或不可变发布事件重建，无法证明时保留 `NULL / legacy_unknown`。API、Console 与 Persistence 定向测试合计 `44/44`，因此旧复审报告中的两项阻断已被后续修复和回归证据取代。
- 应用壳冻结为 `#2563eb / #f8fafc / #0f172a`、248/76px 侧栏、28px 内容留白、26px 页面标题和 320ms 侧栏动画。Overview、通知、沟通草稿、路线、风险、供应商、SLA、Advanced SLA、PO、待我处理与 AP 已使用共享页面标题/流式容器；生产采购树中的 `#2f6df6`、`#1463ff`、旧 rgba、202/252px 侧栏、1720px 容器和 28/32px 页面标题搜索为 0。
- 当前验证全部 exit 0：视觉/导航/Advanced SLA Console `28/28`、全仓 `491/491`、TypeScript、Next.js 16.3.3 production build。该轮没有修改正式 SQLite，没有发布 SLA、确认路线、处置安全事故、创建新 Outbox、发送邮件或写 Odoo。
- 正式 V1 readiness 仍以真实租户事实为准，不因工程测试通过而抬高：在真实 PO 全闭环、正式身份/SLA、路线与安全处置完成前继续保持 `blocked`。

## 13. 2026-08-30 租户时区与日期格式整站消费

- Migration 39 与 `GET/PUT /api/procurement/tenant-preferences` 已把国家、工作日、IANA 时区和日期格式变为租户级真实合同；读取、配置权限、严格校验、乐观锁、租户隔离与追加审计均由 API/SQLite 负责，前端不使用 localStorage 冒充持久化。
- Console 根部只加载一次共享偏好并通过 Context 广播；保存成功后无需刷新即可让整站日期切换，刷新后从 SQLite 恢复。采购总览、PO 六页签、采购需求、RFQ、供应商、AP、路线、风险、通知、沟通草稿、SLA、PO Intake、运行、连接器、安全、部署、身份与 readiness 均消费同一格式工具。
- 所有业务时间仍保存为 ISO 时间或 date-only 业务日期；显示层按租户时区/格式转换。date-only 不做 UTC 偏移；风险日期范围与 PO Intake 默认下单日使用租户日历日，不再依赖浏览器所在地。
- 定向 `6/6` 覆盖上海 `YYYY-MM-DD`、伦敦 `DD/MM/YYYY`、纽约 `MM/DD/YYYY`、UTC 跨日、date-only 不漂移、无效输入/时区回退和 DST 日期范围。Console 与全仓 TypeScript、ESLint 0 error/0 warning、Next.js 16.3.3 production build、全量 `498/498` 均 exit 0。
- Business API 已单独安全重启，正式 SQLite 从 migration 38 升至 `39|procurement-tenant-preferences`，偏好与事件表存在；4173 health=200，匿名读取返回 401。刷新已打开的采购订单页后，应用明确显示登录过期且浏览器 error/warn 日志为 0；没有触发邮件、Odoo、SLA 发布或业务写动作。
- 基础 SLA 已新增显式 `elapsed_hours / tenant_working_days`：旧规则缺字段时继续按自然小时，只有明确选择工作日的规则才读取租户时区与工作日，因此升级不会静默改变正式策略。
- 应用内浏览器已能打开本地平台，但当前会话过期；未使用历史账号或凭据代登录。本项的跨页即时切换、刷新恢复、409/无权限与三个桌面视口鉴权验收仍待用户重新登录后完成。

## 14. 2026-08-30 SLA 租户工作日日历

- `apps/api/src/procurement-sla-calendar.ts` 提供纯、确定性的日历运算：自然小时直接按 UTC elapsed time；租户工作日按 IANA 时区中的本地墙上时钟小时累计，跳过未配置为工作日的日期，支持正负偏移、周末边界与 DST gap/overlap。
- SLA 策略 JSON 新增显式 `calendarMode`，不需要平行表或前端本地状态；创建/更新仍走严格字段校验、乐观版本和租户权限。旧策略解析时补为 `elapsed_hours`，复制/再次保存后持久化显式值。
- 目标期限、预警、宽限与已发送跟进后的下一次跟进都使用同一日历函数。工作日评估把 `calendarMode / calendarTimeZone / calendarWorkingDays / calendarPreferenceVersion / calendarInheritedDefault` 写入 `evidence_json` 和 fingerprint；发布策略事件冻结发布时日历。偏好版本变化后的重算会新增 `evaluation_changed` 事件和投影版本。
- SLA Web 草稿表增加“计时日历”列，展示真实租户时区、工作日与偏好版本；已发布规则与展开证据都显示日历语义。当前浏览器会话过期，登录后的保存、发布、409/无权限和三个桌面视口验收仍待完成，不能据此把完整 Navisight V1 标记完成。
- 本纵切验证全部 exit 0：Console 与全仓 TypeScript、ESLint 0 error/0 warning、Next.js 16.3.3 production build、全量 `505/505`。Business API 已安全重启并恢复 IMAP、Outbox、document、SLA 与 Context workers；4173 health=200、匿名 SLA=401。正式 SQLite 仍为 1 份未发布草稿、0 条评估、0 条租户偏好，Outbox 仅 4 条历史 `dispatched`，没有发布策略、发送邮件或写回 Odoo。

## 15. 2026-08-30 真实供应商回复到结构化确认

- 正式上下文已确认 `P00021` 存在 2 封由 `imap.163.com` 接收、发件人匹配当前供应商、线程关联当前 PO 的真实入站回复；回复正文包含延期及只能交付一半的信息，但此前只有原邮件证据，没有结构化 Confirmation、差异审批或可继续执行的 Web 动作。
- PO Web 工作台现于 Supplier Commitment 阶段提供“从供应商回复登记确认”：操作人必须选择当前 PO 的真实入站回复，并逐行明确填写确认数量、确认单价和承诺交期。空字段不会被解释为沿用 PO；数量或价格变化、以及交期延后超过 2 天会创建人工审批，批准前不推进数量累计或生产阶段。提前交付或 1–2 天交期变化仍显示为差异，但不会被前端错误标成后端审批条件。
- 确认弹窗已直接展示所选真实 Communication 的主题、发件人、接收时间、Message-ID、证据 ID 和完整文本正文；正文使用 React 文本 / `pre` 只读渲染，不注入邮件 HTML。“按 PO 原值填入未变更项”只填充空白表单：数量取 ordered quantity，单价仅在 PO 明确记录时填入，交期按租户 IANA 时区转为日历日期；已手工录入的差异不被覆盖，点击也不提交、不持久化、不发邮件或回写 Odoo。
- API 在执行 `record_confirmation` 前重新校验通信证据的 tenant、PO、supplier、`businessObjectType=purchase_order`、`direction=inbound` 与 `status=received`；错误租户、错误 PO、错误供应商或任意字符串引用统一返回 422。Odoo `confirmed` 只作为 ERP 订单状态观察，不再阻止后续真实供应商回复形成精确结构化确认。
- 定向 API 回归、根与 Console TypeScript、ESLint 0 error/0 warning、Next.js 16.3.3 production build均通过。运行态对 `P00021` 使用无效通信引用得到 422，随后上下文仍为 `confirmed · version 1 · 0 confirmations · 0 pending approvals · 2 trusted inbound replies`，证明失败请求没有产生部分写入或外部副作用。
- Business API、Control API 与 Console 已恢复为 HTTP 200，本机演示身份 `/api/auth/me` 返回管理员，Outbox 仍只有 4 条历史 `dispatched` 且无 active 项。内置浏览器控制继续被本地 URL 安全策略拒绝，未绕过；新 Web 表单的人工视觉验收仍需用户刷新已打开的 3001 标签页。正式 `P00021` 也尚未提交结构化确认，避免在未由人核对单价与日期前制造业务事实。
- 2026-08-31 只读复核 Business API：`P00021` 仍为 `confirmed / 0 confirmations`，2 封真实 QQ 供应商回信分别返回 407 / 416 字符正文与可验证 Message-ID。新增视图模型定向测试 `9/9`、全量 `528/528`、全仓 TypeScript、Console ESLint 和 Next.js 16.3.3 production build 全部通过；本纵切未改变正式 readiness、PO 状态或任何外部副作用。

## 16. 2026-08-30 供应商邮件身份事故证据与自动收敛

- 7 个正式未处置事故均来自历史 IMAP UID 的 `SUPPLIER_EMAIL_MISMATCH`；此前拒绝表没有保存实际 `From` 邮箱，安全页只能展示主数据允许邮箱，无法直接对照根因。Migration 41 新增 `observed_sender`，只持久化从 `From` 头规范化出的邮箱地址，不保存任意头文本；新拒绝事故同时显示实际发件邮箱、允许邮箱、PO、供应商、处理次数和退避期限。
- 同一 UID 后续通过当前租户、PO、供应商与邮箱身份校验并成功写入采购证据链时，系统会保留全部不可变原始事件，并由 `connector:email` 自动追加“已修复”处置与审计；不会因删除拒绝队列行而留下陈旧发布阻断，也不会把仍未成功入库的历史邮件自动标记已修复。
- 同时修复 SLA 评估事件在同一时间戳下使用随机 UUID 倒序导致的展示不稳定，改为同时间按 SQLite 插入顺序倒序；IMAP 成功轮询后也不再从旧失败运行回显过期错误。定向迁移/IMAP/安全事故 `26/26`、全仓 `513/513`、根与 Console TypeScript、ESLint 0 error/0 warning、Next.js 16.3.3 production build均通过。
- 正式 7 个历史事故尚未被处置：它们发生在 `observed_sender` 上线前，必须从原始邮件头核验或在下一次真实重试中取得成功入库证据；本轮没有接受风险、删除原始事件、修改供应商主数据、发送邮件或写回 Odoo，因此 V1 readiness 仍诚实保持 `blocked · 6/11`。
- 本地运行栈已安全重启并加载 Migration 41；3001/4173/4174 均为 HTTP 200，首次 IMAP 轮询完成且 `lastError=null / consecutiveFailures=0`，Outbox 仍只有 4 条历史 `dispatched`、无 active 项。`P00021` 的 Odoo PO 与“上海卓越阀门”主数据只保存名称、USD 币种和联系人，没有国家、地址、合同或 Incoterm 证据，因此没有仅凭供应商名称把路线伪判为本地采购。

## 17. 2026-08-30 Web 登录恢复与流程图入口

- 应用壳新增统一鉴权门：采购页面在 `GET /api/auth/me` 成功前不挂载；业务请求中途返回 401 会统一回到登录页，避免每个页面各自显示“连接后端”或继续展示旧数据。登录视觉使用 Navisight 公开应用可验证的独立 Welcome / Username / Password / Sign In 骨架，但不复制其无会话 API 暴露行为。
- 本地密码登录只在 `READYWORK_DEMO_AUTH=1` 的非生产 API 进程中可用。签名令牌通过 `HttpOnly; SameSite=Lax; Path=/` Cookie 交付，生产请求另强制 `Secure`；登录响应不向前端 JavaScript暴露 token。Web 退出会撤销当前进程令牌、清除 Cookie，并让后续读取真实返回 401。
- 本地验收账户与匿名管理员已拆成两个开关：只启用演示账户不再匿名降级；旧兼容行为还需另行显式设置 `READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH=1`，正常验收和生产均不使用。控制面 HTTP 集成测试也改为先登录，再用 Cookie 读取 readiness，不再依赖匿名管理员。
- HappyRobot 风格流程图采用轻量桌面入口：侧栏底部的“流程图”按钮直接打开真实采购智能体 Editor；6 条工作流、节点、连线、版本、运行和 Runtime/Connector 状态仍由控制面 API 与 SQLite 返回，不另建演示数据源。已有手机端入口不作为 V1 验收证据。
- 同一张 React Flow 画布已叠加真实持久化 NodeRun：可按当前工作流选择最近或历史运行，节点按执行中、等待、完成、拦截、失败显示状态，当前路径连线与 MiniMap 同步着色；只有 queued/running/waiting 运行每 2 秒读取 `/api/editor/runs/:id`，终态运行停止轮询。新建运行会自动成为当前叠加对象，不再用前端定时器伪造执行进度。
- 采购实时刷新增加 `/api/events?stream=1` SSE 纵切：Migration 42 使用租户隔离的单调游标记录 `pos/outbox/messages/notifications` 元数据，支持 `Last-Event-ID` 重放、积压 reset、keep-alive 与断线重连；首页、PO 工作台/详情、沟通草稿、通知和 PO Chat 已接入，客户端收到事件后重新读取权威 API，不把事件载荷当业务事实。
- 真实 HTTP 探针已验证：auth config 200、登录 200、响应无 token、Cookie 含 HttpOnly、`/api/auth/me` 200、跨 Next rewrite 的控制面工作流 200 且返回 6 条持久化工作流、退出 200、退出后 401。应用内浏览器已验证未登录页完整渲染；根据浏览器安全边界，本轮未替用户输入或提交密码，因此登录后流程画布的最终视觉复核仍待用户自己登录后继续。
- 回归证据全部 exit 0：鉴权定向 `6/6`、readiness HTTP 集成 `4/4`、流程运行叠加定向 `2/2`、SSE/持久化/工作台边界定向 `47/47`、全仓 `517/517`、根 TypeScript、Console ESLint 0 error / 0 warning和 Next.js 16.3.3 production build。本轮未发送邮件、未写 Odoo、未发布 SLA、未确认路线或结构化供应商回复。

## 18. 2026-08-30 Material Lead Times (SLA)

- Migration 43 新增 `procurement_material_lead_times` 与 `procurement_material_lead_time_events`，将 Navisight 公开 `/api/po/lead-times` 合同实现为真实供应商-物料制造交期主数据。每条记录绑定当前租户供应商 ID、审核后的 Local/Import 路线和物料编码/名称/默认匹配键，供应商名称仅作快照，不用于猜测身份或路线。
- 精确 API 为 `GET /api/po/lead-times`、`POST /api/po/lead-times`、`PATCH /api/po/lead-times/:id`、`DELETE /api/po/lead-times/:id`。写入使用严格字段白名单、租户隔离、配置权限、变更/退役依据、活跃匹配唯一约束和 `expected_version` 乐观锁；DELETE 只退役当前版本，历史与追加审计不删除。
- PO 工作台在每次组合计算时读取一份活跃解析器，严格按“供应商 + 路线 + 物料编码”、物料名称、供应商/路线默认值的顺序匹配；未分类路线不消费模板。下单日到要求到货日的可用天数不足时产生 `manufacturing_lead_time_shortfall`，风险与 SLA 证据同时冻结模板 ID/version、匹配方式、PO 行、可用天数和缺口天数。
- `Material Lead Times (SLA)` 真实面板已在 2026-08-31 按公开应用结构从 Configuration 移入 Suppliers，使用 Supplier、Material、Item Code、Route、Lead Time、Remarks、Actions 七列密度；供应商下拉、创建、编辑、退役、409 冲突、空/错误/权限态与审计均来自同一 API/SQLite 纵切，未使用前端样例数据或假成功。
- 定向验证已覆盖鉴权、RBAC、严格字段、供应商绑定、跨租户、重复键、乐观锁、风险/SLA 证据、退役、刷新、重启恢复和并发迁移。正式 `data/readywork.sqlite` 尚未加载 Migration 43，也不会在无真实供应商制造周期证据时插入样例交期；需安全重启 Business API 后再完成正式库与鉴权浏览器验收。

## 19. 2026-08-31 风险快照新鲜度

- 总览使用当前 PO 事实实时计算风险，Risk Dashboard 使用不可变持久化快照；正式库因此可能同时出现“当前 13 个高风险”和“8 月 28 日快照 9 个高风险”。这不是同一时点的两个口径，但旧页面只显示快照时间，容易让用户误读。
- `GET /api/procurement/risk-dashboard` 现返回只读 `freshness` 合同：`current / stale / missing`、当前与快照 source watermark、评估时间、过期原因和当前组合风险计数。GET 仍不创建或改写快照；日期推进与采购事实变化分别标记为 `calendar_day_changed / portfolio_facts_changed`。
- 风险看板在快照过期时明确并排显示“快照 9 / 当前只读重算 13”，解释图表和 CSV 仍使用原快照，并只在用户点击“更新风险快照”后持久化新审计点；新鲜时显示“与当前组合一致”。
- 定向 API 测试覆盖 missing → current → calendar-day stale → refresh current，根 TypeScript 与 Console ESLint 通过。Business API 已安全重启，登录态浏览器已用正式 26 张活跃 PO 验证过期提示精确显示 9 → 13；未点击更新快照、未修改采购事实、未发送邮件、未调用 Odoo，也未改变 V1 readiness。

## 20. 2026-08-31 Odoo 采购路线证据发现

- Odoo PO 只读契约现明确读取 `incoterm_id`、`incoterm_location`、`dest_address_id` 与 `picking_type_id`，并在采购同步时写入当前版本化 PO JSON。`picking_type_id` 只保留为操作上下文，不能把“收据”等仓库操作类型误当作本地/进口路线证明。
- 路线证据候选按交易相关性排序：当前 PO 的真实 Incoterm 优先，其次才是当前版本供应商主数据中的国家/地址。两类候选都使用 `erp_field` 且绑定 PO 版本；供应商地址还绑定供应商版本。后端保存前会重新生成候选并精确匹配 reference，伪造引用和版本已变化的旧引用均返回 422。
- 路线页未分类队列和确认弹窗已能区分 `Odoo PO Incoterm` 与 `Odoo 供应商地址`，并明确说明候选只用于人工判断，不自动推断路线。没有 Incoterm 与地址时显示可操作缺口，引导先在 Odoo 补齐或改用合同/人工复核证据。
- 正式 Odoo 只读盘点仍显示 30 张 PO 的 Incoterm、Incoterm location 与目的地址均为空；全部 PO 的 `picking_type_id` 仅为收货操作类型。因此本轮没有执行正式同步、没有确认任何路线，26 张活跃 PO 仍应保持未分类，V1 readiness 不因工程能力完成而提高。
- 定向连接器/同步/路线测试 `16/16`、全量测试 `528/528`、根 TypeScript、Console ESLint 和 Next.js 16.3.3 production build均通过。Business API 已重启加载新契约，后台 worker 只恢复既有健康/轮询记录；本轮未执行正式采购同步或路线确认，未改写采购业务事实、未发邮件、未写 Odoo、未发布 SLA，也未创建 Shipment、收货或 GRN。

## 21. 2026-08-31 采购路线受控文件证据

- 合同与 Incoterm 路线依据不再接受自由文本编号。Migration 44 新增 PO 级证据文件绑定、追加事件和幂等结果；原始文件写入统一 `procurement_attachments`，绑定 `owner_type=purchase_order` 与当前 PO，并进入既有 ClamAV、文档解析、租约、重试和附件审计链。
- `POST /api/procurement/routes/:poId/evidence-documents` 要求操作权限、同租户真实 PO、严格字段白名单、8 MB 上限和 `Idempotency-Key`。上传成功只表示已持久化；`security_status=clean` 且 `processing_status=parsed` 前候选保持不可选，隔离文件保留审计但不能用于路线确认。
- 可用文件候选冻结路线证据记录版本、附件版本、SHA-256、业务引用、文件名、扫描/解析状态和 PO 版本。确认路线时后端重新生成候选并精确匹配；文件被替换、撤销、隔离、类型不符或版本变化后，旧 reference 返回 422。`contract` 不能冒充 `incoterm`，任意合同号 / 贸易条款字符串也不能冒充受控文件。
- Local / Import 的路线确认弹窗已接入真实上传、扫描中 / 解析中 / 已隔离 / 可用于确认状态，并且只有当前类型的 eligible 候选才允许“保存并记录审计”。刷新后全部状态从 API / SQLite 恢复，不使用 localStorage 或假成功。
- 隔离验收覆盖未登录、无权限、跨租户、超限、伪装可执行文件、幂等重放 / 冲突、扫描前阻断、fake ClamAV clean 后启用、旧版本失效、类型错配、路线版本冲突和数据库重启恢复。路线 / 文档 worker / 持久化定向 `13/13`、全量 `528/528`、根 TypeScript、Console ESLint 与 Next.js 16.3.3 production build均通过。该能力完成不等于正式业务路线已确认：正式 26 张活跃 PO 仍保持未分类，readiness 与真实五阶段闭环不得因测试通过而提高。

## 22. 2026-08-31 路线证据复用与可审计撤销

- `GET /api/procurement/routes/:poId/evidence-documents` 统一返回已绑定证据、可复用的当前 PO 附件、证据事件和当前操作权限。附件只有在同租户、归属当前 PO、active、ClamAV `clean`、已解析且具有有效 SHA-256 时才标记为 eligible；可打开地址仍经同源鉴权内容路由。
- `POST .../evidence-documents/bind` 使用 `Idempotency-Key` 与附件版本 / SHA-256 双重校验，将现有 clean / parsed PO 附件绑定为合同或 Incoterm 证据；跨 PO、跨租户、旧版本、重复绑定和不安全附件均在后端拒绝。
- `DELETE .../evidence-documents/:documentId` 只开放给 configure 权限，必须提交撤销原因、`expectedVersion` 和幂等键。撤销保留证据文档、附件审计与路线事件；若当前路线依赖该文档，同一 SQLite 事务内删除路线分配并记录 `route_unclassified_due_to_evidence_revocation`，不让无效证据继续支撑 Local / Import 分类。
- Web 路线工作台已接入真实附件读取、打开、绑定、刷新、证据治理和撤销后退回未分类提示；绑定 / 撤销 / 上传期间会锁住路线确认动作，不使用假成功或前端业务持久化。
- 新定向路线测试 `1/1`、全仓 `528/528`、根 TypeScript、Console ESLint 0 error / 0 warning 和 Next.js 16.3.3 production build 已通过。Business API 已精确重启装载新路由，4173 health=200，匿名读取证据返回 401；正式 SQLite 已有 Migration 44，证据文档与路线分配均仍为 0。这一纵切只完成工程能力；未绑定正式附件、未确认路线、未发邮件、未写 Odoo、未发布 SLA，因此正式 readiness 和五阶段闭环计数不变。应用内浏览器的本地 URL 安全策略拒绝了自动刷新，未绕过；鉴权视觉复核需用户手动刷新已打开的 3001 页面后继续。

## 23. 2026-08-31 Supplier Commitment 提交前差异预检

- 供应商确认弹窗新增无副作用的逐行差异预检：数量、单价和承诺交期同时显示 PO 原值、人工核对值与差异；空白或非法输入保持“待填写”，不会被 JavaScript `Number("")` 误当作 0。
- 预检与正式 `executeRecordConfirmation` 现在共同调用 `packages/core/src/procurement-confirmation.ts` 的单一领域合同：数量或单价不一致即预计审批；交期延后超过 2 天才预计审批。提前交付和 1–2 天变化仍作为可见差异，但与“预计创建审批”分开呈现。PO 原交期按租户 IANA 时区显示；提交时间戳差异继续与 API / repository 的权威计算一致。Console 与根测试运行器均使用同一模块别名，避免开发、测试和生产各自解析成不同实现。
- 缺少 PO 单价或原交期基准时，比较结果保持 unknown，不猜测；多行聚合明确显示完整行数、差异行数、预计审批行数。只有字段齐全且比较基准充分时才显示“后端重校验后可能直接推进”，前端预览本身不保存 Confirmation、审批或阶段事件。
- 定向领域 / Web / 持久化测试 `46/46`，覆盖真实短交形态 300 → 150、单价不变、上海跨 UTC 日历边界、2/3 天交期阈值、缺少单价基准、空输入、多行聚合，以及 SQLite 中两天直接确认 / 三天创建 pending 审批；全仓 `534/534`、根 TypeScript、Console ESLint 0 error / 0 warning、Next.js 16.3.3 production build全部通过。
- 本轮未提交 `P00021` 的结构化确认，未创建审批、未发送邮件、未写 Odoo、未发布 SLA、未确认路线，也未创建 Production Progress、Shipment、Receipt 或 GRN。正式 readiness 因此仍以 `blocked · 7/11` 的真实只读结果为准。应用内浏览器仍被本地 URL 安全策略拒绝自动刷新，未绕过；视觉验收需用户手动刷新 3001 后打开 `P00021` 的“从供应商回复登记确认”。

## 24. 2026-08-31 公开产品页、FAQ 与 Demo 申请纵切

- 新增无需采购工作台会话即可访问的 `/product`。根 `/` 继续由统一 `AuthGate` 保护；公开例外只包含精确路径 `/product`，不会把内部采购页面或 API 变成匿名可读。页面 metadata、导航、Hero、五阶段、风险可见性、7 项 FAQ、Demo 和页脚均按当前 Navisight 官网公开骨架实现，同时明确标注 `Supervised procurement execution V1`。
- 官网当前 Demo 字段已用只读浏览器逐项核对：Full name、Work email、Company 为必填；Role、Country、ERP system、Monthly PO volume 和 pilot message 为可选；ERP 选项为 SAP / QuickBooks / Other / No ERP，月 PO 量为 Under 100 / 100 to 500 / 500+。本轮没有向 Navisight 官网提交表单。
- Readywork Demo 表单不做前端假成功。`POST /api/public/demo-requests` 只有在严格字段 / 枚举 / 长度 / honeypot 校验、调用方幂等键校验、SQLite 主记录与追加审计事件同一事务提交后才返回 201；相同键同载荷返回原记录并追加 replay 审计，不同载荷返回 409。成功文案明确说明没有自动发送外部邮件或 CRM 动作。
- Migration 45 新增 `public_demo_requests` 与 `public_demo_request_events`；正式库已加载 `45|public-demo-requests`，两表均保持 0 行。运行态用非法邮箱 HTTP 探针得到 `400 DEMO_REQUEST_INVALID`，随后两表仍为 0，证明拒绝请求不会产生部分写入。有效创建、重放、冲突、规范化和安全校验只在 `:memory:` / 临时 SQLite 测试完成，未向正式库写入演示联系人。
- `/product` 已在应用内浏览器实际打开，未出现登录页；title、完整 FAQ、Demo 字段 / 选项和公开页首屏均可见。页面现按 2026-08-31 官网公开证据使用 Geist、`#fafbfd / #f3f6fa` 冷灰背景、`#0b1220` 海军蓝主动作、64px 顶栏、居中 Hero、大型产品截图、五阶段、风险看板和深色 Demo 区；公开截图只作营销页视觉证据，不写入业务数据库。
- 桌面浏览器已逐一验收 1280×720、1440×900 和 1920×1080：三档均无页面级横向溢出，Hero 使用官网实测的 80px 视觉标题并保留 1180px 最小桌面骨架，Console 0 error / warning。官方 `risk-dashboard` 的 3840px 代理资源在浏览器中长期未完成，已切换为同一官方资产的 1920px 版本并验证 `1920×1080` 自然尺寸真实加载；不是空白占位或本地 Mock。
- Demo 表单残留绿色令牌已统一为产品页的冷灰 / 海军蓝系统；按钮仍只在真实 API 请求完成后进入成功态。手机端、移动导航、抽屉和小屏重排明确延后，未为本轮桌面验收投入实现。
- 本条中的旧法律链接判断已由第 48 节更新：官网在 2026-09-01 已发布 `/privacy` 与 `/terms`，Readywork 现提供同构 Pre-release 页面；正式运营主体、联系人、保留期、处理商、管辖和商用合同仍保持待法律审批。公开 FAQ 的供应商身份、上线速度和安全回答继续按 Readywork 当前真实门禁收紧。
- 历史定向 Demo / Persistence `13/13`、全仓 `538/538` 已通过；本次桌面视觉收口后再次运行 Channel + Demo + Persistence 定向 `15/15`、根 TypeScript、Console ESLint 0 error / 0 warning和 Next.js 16.3.3 production build，全部 exit 0。没有发送邮件、写 Odoo、发布 SLA、确认路线或推进正式 PO，因此 V1 readiness 仍保持 `blocked · 7/11`。

## 25. 2026-08-31 Configuration 通信与业务系统首屏

- Configuration 首屏新增“通信与业务系统”结论面板，直接告诉管理员 Email、WhatsApp Business 和 ERP/Odoo 能否执行，并深链到同一 Connector 目录中的对应配置；没有新建平行连接状态或数据库表。
- 状态由现有 Connector 安装/运行健康、加密凭据连接与外部测试事实共同派生。只有 `runtimeHealthy + credentialReady + externalVerified + connected credential` 同时成立才显示“已验证”；其余诚实区分待测试、未配置、需修复、已停用和不可用。
- 正式 SQLite 只读证据显示 Email 与 ERP 的 connected credential 均已经外部验证，因此面板显示两者“已验证”；WhatsApp Connector 已安装但没有 Meta 凭据，必须显示“未配置”，不伪造配对或送达。
- 新增 View Model 定向测试 `2/2`，根 TypeScript、相关 Console ESLint、Next.js 16.3.3 production build 和全仓 `540/540` 全部通过。内置浏览器对已打开的本地 URL 拒绝自动刷新，未绕过策略；登录后的桌面视觉验收仍是独立门槛。
- V1 只继续验收 1280×720、1440×900 和 1920×1080 桌面视口。手机端、移动导航与小屏组件重排全部延后，不改变真实 PO 闭环的发布门槛。
- Configuration 已补齐 1280×720 与 1920×1080 登录态验收：三张通道卡始终位于 readiness 之前，宽度分别为约 321px / 534px，页面 `scrollWidth === clientWidth`，控制台 0 error / warning。结合此前 1440×900，Configuration 三档桌面门槛现已完成；手机端仍明确延后。
- 权威 readiness 重新读取为 `blocked · 7/11`。已就绪项为 SMTP、IMAP、Odoo、ClamAV、Temporal、Manufacturing Context 和安全事故处置；四个阻断项仅为具名采购身份、正式 SLA、本地路线证据和真实五阶段闭环。正式库现有 43 条安全原始事件、8 个聚合事故均保留审计且已处置，不再沿用旧的“7 个事故未处置”结论。

## 26. 2026-08-31 Odoo 路线证据同步纵切

- Local / Import 工作台新增“同步 Odoo 路线证据”，直接复用正式 `POST /api/procurement/suppliers/sync`，同时提交调用方幂等键；按钮不修改 Odoo、不发送邮件，只刷新 Readywork 的版本化供应商主数据，再重新读取采购组合。
- 页面新增 `ERP 可用证据 n / 未分类 PO` 覆盖率，只统计活跃、未分类且存在 eligible `erp_field` 候选的 PO。同步结果会诚实区分“已有可确认候选”和“Odoo 仍缺 Incoterm / 国家 / 地址”；供应商名称、邮箱域名和 USD 币种均不会被推断成路线。
- 正式页面已在 1280×720 点击执行一次：结果为新增 0、更新 0、未变化 10、坏行 0，覆盖率保持 `0/26`。`supplier_sync_idempotency` 已保存本次 `route-evidence-source-sync:*` 结果与载荷哈希；`procurement_route_assignments` 仍为 0，证明同步没有制造本地 / 进口事实。
- 新增纯 View Model 定向覆盖无证据与部分有证据两种结果；采购路线 + 新 View Model + Configuration 通道定向 `5/5`、根 TypeScript、相关 ESLint、Next.js 16.3.3 production build全部通过。浏览器无横向溢出且 0 error / warning。

## 27. 2026-08-31 Advanced SLA 规则依赖闭环

- Production / Service Milestones、Regulatory / Import Approval 与 Customs Clearance 不再要求采购经理手工输入逗号分隔的规则 ID。桌面 Web 只从当前真实草稿的九域规则生成依赖候选，排除当前规则，并同时展示规则名称、所属领域与稳定 ID；没有其他规则时显示诚实空态。
- 删除草稿规则会在同一个本地编辑状态中移除其他规则对该 ID 的引用，避免留下隐藏的悬空依赖；真正保存时仍由后端规范化器重新验证依赖存在、自依赖和全图循环，前端选择器不作为权威门禁。
- 核心合同新增跨九域依赖图门禁，拒绝 `A → B → A` 以及更长的循环。该校验同时覆盖 JSON 创建/更新、CSV 预览/应用和 Console 保存，因为三条路径继续共用 `normalizeAdvancedSlaSections`；没有增加第二套规则状态或前端持久化。
- 定向 Advanced SLA API / Console 测试 `23/23`、全仓串行 `540/540`、根 TypeScript、相关 ESLint 0 error / 0 warning与 Next.js 16.3.3 production build 全部通过。
- 登录态 Advanced SLA 空态已在 1280×720、1440×900、1920×1080 三个桌面视口复核，页面级无横向溢出且 Console 0 error / warning。正式库仍为未发布、无 Advanced SLA profile、26 张活跃 PO / 0 张匹配 PO；本轮没有创建草稿、发布策略、启动自动发送、发送邮件、写 Odoo 或改变正式采购事实。手机端继续不在 V1 范围内。

## 28. 2026-08-31 PO 制造上下文证据层收口

- PO Overview 不再默认铺开实体、关系、事实证据、缺失事实、冲突、Agent 记录和投影水位。默认层只显示由同一 Context API 响应派生的实体、证据、缺失、冲突与投影状态；点击“展开制造上下文”后才挂载完整证据层，没有新增第二套 API、Mock 或前端业务事实。
- 摘要实体数会对根实体与 entities 集合按稳定 ID 去重；切换 PO 会同时清空旧响应、收起证据层并丢弃上一张 PO 尚未提交的纠正草稿，避免跨对象短暂显示或误提交。事实纠正仍只创建待审批记录，不直接改写 Twin 或采购事实。
- 正式 P00021 的登录态摘要如实显示实体 6、证据 14、缺失事实 5、冲突 1、投影当前；折叠态不渲染完整“实体摘要”等 section，展开后完整证据仍可读。PO 五阶段继续显示 PO Sent=Completed、Supplier Commitment=Active、其余三阶段 Pending；行级累计仍是订购 300、已发 0、已收 0，没有为视觉填充伪造 Confirmation、Shipment 或 GRN。
- 1280×720、1440×900、1920×1080 三档桌面视口均为页面级 `scrollWidth === clientWidth`；折叠与展开时均无横向溢出，投影状态值完整显示，Console 0 error / warning。手机端、移动导航、抽屉和小屏重排继续不在 V1 范围内。
- 纯 View Model / 展开状态定向测试 `6/6`、根 TypeScript、相关 Console ESLint 0 error / 0 warning与 Next.js 16.3.3 production build通过。本纵切只改变真实 Context 数据的呈现层，没有写正式 SQLite、发送邮件、调用 Odoo、发布 SLA、确认路线或推进 P00021 阶段；V1 readiness 继续以 `blocked · 7/11` 为准。

## 29. 2026-08-31 PO Timeline 官网纵向骨架

- 已直接复核 Navisight 官网 `#how-it-works` 的公开真实 PO 示例及 `po-timeline` 资产：Timeline 使用纵向节点与连接线，每个阶段显示名称、Completed / Pending 等胶囊和业务说明；不是五张横向小卡。Readywork Overview 原来的 `sm:grid-cols-5` 在 347px 固定详情栏中把 Fulfilment / Production 等名称挤碎，现已删除。
- Overview 改为与官网同构的纵向 Timeline：Completed 使用蓝色实心勾选节点与已完成连接线，In progress 使用蓝色空心活动节点，Pending 使用灰色节点和连接线，Blocked 使用红色节点。阶段名称、说明和状态全部读取现有 `stageTimeline`；新增 View Model 只补序号、英文状态文案和连接线样式，不排序、不完成、不推进阶段。
- History 继续复用同一个 Timeline，并为每个阶段保留默认折叠的证据 / SLA 层；Overview 只展示官网默认信息层，避免重复展开时间、水位和 SLA。固定详情栏内的证据栅格改为单列，避免基于页面 viewport 的 `sm:grid-cols-2` 把 287px 卡片错误切成窄列。
- 正式 P00021 仍显示唯一真实阶段链：PO Sent=Completed、Supplier Commitment=In progress、Fulfilment / Production=Pending、Dispatch / Transit=Pending、Delivery / GRN=Pending。没有因视觉对齐把供应商邮件冒充结构化确认，也没有开放 Shipment / GRN 的越级动作。
- 1280×720、1440×900、1920×1080 三档登录态验收中，Timeline 卡宽 287px、高 702px，每个阶段 `scrollWidth === clientWidth`，页面级无横向溢出；History 中 5 个阶段均保留证据 disclosure，Console 0 error / warning。手机端继续不在 V1 范围内。
- 采购工作台 API + PO Detail View Model 定向测试 `28/28`、根 TypeScript、相关 ESLint 0 error / 0 warning与 Next.js 16.3.3 production build全部通过。本纵切没有写正式 SQLite、发送邮件、调用 Odoo、发布 SLA、确认路线或推进正式 PO；readiness 保持 `blocked · 7/11`。

## 30. 2026-08-31 PO 详情标题与六页签桌面可用性

- 347px 固定任务详情栏不再把 `P00021 · Supplier Commitment` 塞入一条带省略号的标题。头部改为两层：第一层显示完整 PO 编号与真实状态胶囊，第二层独立显示完整正式阶段名；阶段名允许自然换行，但不得截断或缩写。
- Overview / Items / Supplier / Documents / History / Communication 继续使用唯一一套 canonical 页签、稳定 ID、URL 状态和键盘契约。52px 页签条保持单行横向滚动，隐藏原生滚动条，并增加 32px 左右滚动入口；一次向右翻页即可完整露出 History 与 Communication。
- 页签切换只计算 tablist 自身的横向边界并调用 `scrollTo`，不使用会连带滚动祖先容器的 `scrollIntoView`。ArrowLeft / ArrowRight / Home / End 继续移动选中态和焦点；当前页签会完整进入可见区，详情正文 `scrollTop` 与页面 `scrollY` 不因页签露出而跳动。
- 登录态 P00021 在 1280×720、1440×900、1920×1080 三档验收：任务标题 `clientWidth === scrollWidth === 297px`，页签可视宽 281px / 内容宽 560px，三档页面级均无横向溢出；1280 下右翻一次到最大 `scrollLeft=279px` 后 History 与 Communication 均完整可见。Console 0 error / warning。
- 采购工作台 API、PO 导航与 PO Detail View Model 定向测试 `34/34`，根 TypeScript、相关 Console ESLint 0 error / 0 warning及 Next.js 16.3.3 production build全部通过。本纵切只改变桌面 Web 呈现和页签可达性，没有写正式 SQLite、发邮件、调用 Odoo、发布 SLA 或推进 P00021；V1 readiness 继续以 `blocked · 7/11` 为准。手机端、移动导航、详情抽屉和小屏重排继续延后。

## 31. 2026-08-31 真实供应商回复的冲突感知结构化建议

- `packages/core/src/procurement-supplier-reply.ts` 新增前后端 / 运行时共用的纯函数合同。它优先执行零模型 token 的确定性提取：只在单行 PO 中将“只能交一半”换算为订购数量 50%，将明确月日与 PO / 通信年份结合，只提取带明确价格标记的单价。多行归属不清、同一回复多值、缺年份与历史回复冲突均不自动采用。
- 邮件中明确的 `------------------ 原始邮件 ------------------` 之后内容会在提取前排除，防止原 PO 数量、日期或单价被冒充为供应商新回复。当前 P00021 最新真实回复“要改为8.10号了，只能交一半”因此只生成 `150 Units` 与 `2026-08-10` 两个高置信建议；单价保持空白。较早回复中的“823”显式保留为“日期 / 数量 / 编号”歧义，不会静默忽略或规范化为 8 月 23 日。
- PO 核对弹窗在原始邮件与逐行事实之间增加“结构化解析建议”：展示字段、置信度、证据片段、缺失字段和冲突。“将可靠建议填入空白项”只填高置信值，不保存、不提交且不覆盖人工输入；浏览器已证明人工将数量改为 140 后再点击仍保留 140。正式提交继续走原 `record_confirmation` 后端证据、版本、供应商与差异审批门禁。
- `ai.supplier_reply_parse` 内置节点改为调用同一合同，保留旧 `intent / facts` 输出外形，并在节点目录中明确标注默认为零模型 token；不再维护前端与智能体两套矛盾规则。复杂、无法确定的语义未在此规则层自动执行，仍须进入人工核对或后续受控模型路由。
- 定向新增测试 `8/8`，全仓 `548/548`、根 TypeScript、Console TypeScript、相关 ESLint 0 error / 0 warning及 Next.js 16.3.3 production build 全部通过。登录态 P00021 弹窗在 1280×720、1440×900、1920×1080 三档桌面视口均无页面级水平溢出，建议卡内容宽 586px，Console 0 error / warning。验收后已取消弹窗；正式 P00021 仍为版本 1、0 条 Confirmation，未发邮件、未写 Odoo、未发布 SLA、未推进阶段。V1 readiness 仍为 `blocked · 7/11`，手机端继续不在 V1 范围内。

## 32. 2026-08-31 短交显式处置与桌面 Web V1 冻结

- Supplier Commitment 的短交审批不再把“批准差异”隐式解释为永久关闭剩余数量。API、SQLite 事务和桌面 Web 现在共同要求显式 `shortfallDisposition: "cancel_remainder"`，且必须填写关闭原因；未知值、拒绝时携带、非确认动作携带以及普通非短交确认伪造该字段都会返回 422。
- 审批、逐行数量投影、Supplier Commitment 完成、Fulfilment / Production 进入及其阶段证据保持单事务。审批 JSON、阶段 evidence 与审计记录会保存处置方式和 `cancelledRemainderQty`，任何一步失败均不得留下部分业务事实。
- 桌面详情从持久化 PO 行、Confirmation 行和数量投影逐行计算短交；缺失确认数量保持未知，不按 0 处理。审批区明确说明“这不是部分发货”，逐行展示订购量、供应商确认量和将永久关闭的剩余量；多计量单位不做错误总计，Items 表头使用“确认差额”而不是“待交付”。
- 操作文案明确副作用：单行示例为“批准短交并关闭剩余 150 Units”，多单位多行显示“批准短交并关闭 2 行剩余量”。关闭原因必填，只有后端真实事务成功后才刷新工作台，不使用前端假成功。
- API / Persistence / Web View Model 定向测试 `45/45`，全仓串行 `548/548`、根 TypeScript、Console TypeScript、相关 ESLint 0 error / 0 warning及 Next.js 16.3.3 production build全部通过。登录态 P00021 Items 在 1280×720、1440×900、1920×1080 三档均无页面级水平溢出，任务详情栏为 347px，Console 0 error / warning。
- 正式 P00021 仍为 `confirmed · version 1`，0 条 Confirmation、0 条待审确认差异、0 条确认批准 / 拒绝阶段事件。本轮没有提交供应商确认、批准短交、发送邮件、写 Odoo、发布 SLA、创建 Shipment、Receipt 或 GRN；当前真实回复仍未说明价格，因此不得推断原 PO 单价 USD 80 继续有效。
- Navisight V1 现在只冻结桌面 Web：1280×720、1440×900、1920×1080。手机导航、移动抽屉、底部导航和小屏重排全部延期，不作为本版实现或发布验收范围。

## 33. 2026-08-31 供应商确认缺失字段跟进草稿

- Navisight 公开产品骨架要求 AI 起草、人工批准后才发送、使用供应商可识别的专业采购身份，并将每次沟通归档到 PO。Readywork 现在将这一骨架落到真实 Supplier Commitment：已有高置信数量 / 交期、仅缺单价时，桌面详情显示“补充确认单价”，不再发送泛化催确认文案。
- `confirmationMissingFields` 只允许用于 `queue_followup`，必须是 1–2 个唯一合法确认字段，并绑定当前租户、PO、供应商的真实 `received + inbound` Communication。API 会在服务端重新执行确定性回复分析；客户端伪造字段、错误邮件或与原文结果不匹配均返回 422。
- Odoo `confirmed` 只是 ERP 订单状态观察；没有正式 Confirmation 文档时，PO 仍处于 Supplier Commitment。因此草稿主题及结构化回复块仍请供应商补齐确认，不会误发成“交付进度”，也不会修改 PO 状态或版本。
- 草稿的 `sourceCommunicationId` 和 `confirmationMissingFields` 同时进入消息草稿、创建事件与 trigger evidence。草稿保持 `draft`，未批准前不进 Outbox、不发邮件、不写 Odoo、不生成 Confirmation 或推进五阶段。
- Web 动作使用 API 返回的 `actionReadiness.queue_followup`。专业沟通身份未配置或供应商缺少真实邮箱时安全禁用，并显示真实缺口；不在前端假设可用。
- 回归结果：全仓 `549/549`、根 TypeScript、Console ESLint 0 error / 0 warning 与 Next.js 16.3.3 production build 均通过。正式 P00021 登录态在 1280×720、1440×900、1920×1080 三档桌面视口均无页面级水平溢出，显示“补充确认单价”且因尚未配置专业沟通身份而禁用，Console 0 error / warning。本轮未点击该动作，没有新草稿、Outbox、邮件、Odoo 写入或 PO 阶段变化。
- V1 仍只交付桌面网页版。手机端、移动导航、移动抽屉、底部导航与小屏重排继续延期。

## 34. 2026-08-31 Drafted Emails 真实决策依据

- 重新逐像素核对 Navisight 官网 `drafted-emails` 桌面资产：左侧 Pending / All 紧凑草稿队列，右侧固定展示待审标签、跟进类型、收件人、正文与 Approve & Send / Edit / Discard。Readywork 保留这一双栏主骨架，不把邮箱、审计或 PO 上下文拆成第二套页面。
- `GET /api/procurement/message-drafts` 与详情现增加服务端构造的 `decisionContext`：稳定返回来源、业务标签、可读摘要、规则 ID、截止时间、缺失确认字段与可信原始 Communication。Web 不再从主题文案或状态色猜测触发原因。
- 供应商回信只有在同 tenant、同 PO、同 supplier、`purchase_order + inbound + received` 全部满足时才可返回。绑定后的草稿可在详情中折叠查看发件人、时间、Message-ID、证据 ID 和纯文本原文；跨对象记录不暴露、不被解释为决策证据。
- 正式 SQLite 经鉴权只读 API 复核得到 3 份既有草稿：P00021 为“承诺交期已逾期 17 天，触发交付升级”，P00001 为逾期 1 天，另一草稿为“供应商确认已等待 76 小时”。这些结论来自原 `trigger_evidence_json`，没有向正式库添加样例数据。
- 工程验证为邮件草稿定向 `6/6`、全仓 `549/549`、根 TypeScript、Console ESLint 0 error / 0 warning 和 Next.js 16.3.3 production build 全部通过。Business API 已在确认无 active Outbox 后精确重启，4173 health=200，Outbox 仍只有 4 条历史 `dispatched`。应用内浏览器本轮对已打开的 `127.0.0.1` 页面拒绝自动刷新和 DOM 读取；未绕过策略，因此不声称此新文案已完成新一轮三视口视觉验收。
- 本纵切只读正式采购事实；没有批准、编辑、丢弃草稿，没有运行 SLA、发送邮件、写 Odoo 或推进 PO 阶段。手机端仍不在 V1 范围内。

## 35. 2026-08-31 Notifications 只读页面与后台投影

- Notifications 页面首次挂载、All / Unread 筛选和 SSE 实时重读现在全部只调用 `GET /api/procurement/notifications`。Web 生产源码不再引用 `/notifications/refresh`，因此只有 read 权限的用户不会因进入页面而触发规则、写 SQLite 或收到 operate 权限错误。
- 显式 `POST /api/procurement/notifications/refresh` 继续保留为受 `operate` 权限保护的运维动作；普通页面不展示额外的“运行规则”按钮。单条已读与全部已读仍是明确、版本化、可审计的人为写动作。
- Business API 新增独立 `ProcurementNotificationWorker`，按真实采购文档、草稿、Outbox 和进口单证事实发现租户，每 60 秒进行一次幂等投影。多次轮询由通知 fingerprint 唯一约束去重，创建事件使用独立系统 actor；通知生成不再依赖某个用户是否打开网页。
- 自动化证明 GET 在读取前后通知表与事件表均为 0 行、只读“审计员”获得 200、同一身份显式刷新获得 403；后台 worker 在新增真实 Receipt 后只生成 1 条 `delivery_completed` 并写入系统 actor 审计。API + Web 定向 `2/2`、全仓 `550/550`、根 TypeScript、Console ESLint 0 error / 0 warning与 Next.js 16.3.3 production build全部通过。
- Business API 已在确认 active Outbox 为 0 后精确重启，4173 health=200，启动日志确认 Notifications worker 已运行。正式 SQLite 仍为 25 条通知、31 条事件和 4 条历史 `dispatched` Outbox；本次后台首次投影没有制造新通知，也没有运行 SLA、发送邮件、写 Odoo 或推进 PO。
- 页面视觉骨架没有变化，仍是 Navisight 单列 Notifications；当前应用内浏览器对已打开本地页面的自动刷新限制仍未绕过，因此本纵切不重复宣称新一轮三视口截图验收。V1 继续只交付 1280×720、1440×900、1920×1080 桌面 Web，手机端全部延期。

## 36. 2026-08-31 Risk Dashboard 桌面工具条与风险语义

- 日期范围收口为单一桌面按钮，点击后在工具条下方打开绝对定位弹层；筛选同样使用右对齐弹层。两者不再把 KPI 和图表整体向下推，且保持互斥、Escape / 点击外部关闭、取消恢复已应用值与显式应用。
- 风险指标变化不再以“数字增加=红色”的通用逻辑呈现。高 / 中风险下降为有利绿色，低风险增加为有利绿色；持平和缺失前期快照保持中性。
- 风险金额卡从当前 / 上一持久化快照逐币种计算变化；最多内联展示两个币种及剩余数量，不会为复制单一美元 KPI 而伪造汇率或跨币种总额。每张 KPI 都增加简短口径说明。
- 风险分布环图改为带圆角空隙的真实分段；官网骨架中不存在的“最高风险 PO”胶囊已删除。快照时间、筛选数、新鲜度和显式更新仍保留，但降为辅助信息层。
- 新视图模型定向测试、风险快照 API 定向测试、全仓测试、根 / Console TypeScript、相关 ESLint 和 Next.js 16.3.3 production build 均通过。正式 SQLite、PO、邮箱、Odoo、SLA 与 Outbox 未因页面收口被改写。
- 本纵切只定义 1280×720、1440×900、1920×1080 桌面 Web。当前内置浏览器的本地 URL 控制策略仍阻止新的登录态 DOM / 三视口取证，未绕过策略，因此本条不声称新的像素级浏览器验收已完成；手机端持续延期。

## 37. 2026-08-31 Overview 纯读取纵切

- 重新核对 Navisight 官网公开 Overview 资产。首页保留“日期范围 → KPI → PO 表 → AI 摘要 → 本地 / 进口风险概览”的桌面信息骨架；真实业务数据只来自 `GET /api/procurement/workbench` 与 `GET /api/procurement/risk-dashboard`，不使用 Mock 或前端拼造采购事实。
- 首页日期由两个直接输入收口为一个日期范围按钮和 360px 浮层。开始 / 结束日期先保存在草稿状态，只有点击“应用日期”才重新读取；默认日期按租户 IANA 时区生成，不再依赖浏览器本地日期算法。
- 首页已彻底删除 `POST /api/procurement/risk-dashboard/refresh`。打开首页、展开日期浮层、修改或取消日期均不会创建风险快照；风险快照写入只保留在 Risk Dashboard 的显式操作中。
- KPI 视觉按官网层级收口：只有首张“高风险”为浅红强调底；“逾期 PO”恢复白底，仅保留红色图标、趋势和折线。路线统计继续诚实显示本地 0、进口 0、未分类 26，不根据供应商、币种或地址猜测路线。
- 新增 Overview 源码只读边界测试；Overview、租户日期、Risk Dashboard 与 Workbench 定向验证 `20/20`，全仓测试、根 / Console TypeScript、全 Console ESLint 与 Next.js 16.3.3 production build 全部通过。
- 1280×720 登录态实页已复核：26 张活跃 PO、13 张高风险、11 张逾期、13 张需关注、19 条未读通知均来自真实 API；页面 `scrollWidth === clientWidth === 1270`，无 `[role=alert]`。日期浮层宽 360px，左 / 右边界为 882 / 1242px；高风险是唯一红底 KPI，逾期卡为白底。
- 当前浏览器控制面没有可用的视口调整能力，因此本纵切不新增 1440×900 或 1920×1080 截图结论；这两档仍属于桌面 V1 目标。手机导航、移动抽屉、底部导航和小屏重排继续延期。
- 验收前后正式 SQLite 均保持 2 个风险快照，最新创建时间仍为 `2026-08-28T02:04:57.129Z`；Outbox 仍只有 4 条历史 `dispatched`。本纵切没有发送邮件、写 Odoo、发布 SLA、确认路线或推进正式 PO，V1 readiness 仍不得宣告完成。

## 38. 2026-08-31 Notifications 官网桌面密度收口

- 重新读取 Navisight 官网当前 1920×1132 `notifications` 权威资产。页面骨架确定为：左侧导航、右上通知 / 用户、`Inbox / Notifications` 标题区、All / Unread、Mark all read，以及单列严重度通知流；官网该页没有顶部全局搜索框。
- Readywork 仅在 Notifications 隐藏全局采购搜索，通知铃铛、实时连接状态和当前用户菜单继续读取真实后端状态；Overview 与其他已有页面的搜索能力不受影响。
- 标题行高收口为 29.9px，标题区底边从约 142px 收口到 124.9px；筛选顶部为 148.9px，列表顶部为 208.9px，与官网资产的桌面密度一致。列表仍使用真实标题、标签、消息、相对时间、严重度点和未读点，不复制官网示例 PO。
- 页面挂载、All / Unread 与实时事件继续只调用 `GET /api/procurement/notifications`。单条打开和“全部标为已读”仍是明确、版本化的真实写动作；本轮浏览器只读验收没有点击这些动作。
- 定向 API / Web 测试 `3/3`、全仓 `554/554`、根 / Console TypeScript、修改文件及全 Console ESLint、Next.js 16.3.3 production build 全部通过。
- 1280×720 登录态实页最终显示 25 条真实通知，其中 19 条未读；页面 `scrollWidth === clientWidth === 1270`、无 `[role=alert]`、无全局搜索框。当前浏览器没有可用的视口调整能力，因此不新增 1440×900 或 1920×1080 本轮截图结论。
- 正式 SQLite 验收前后均保持通知 `read=6 / unread=19`、通知审计事件 31、风险快照 2、Outbox 仅 4 条历史 `dispatched`。没有运行规则、生成通知、发送邮件、写 Odoo、发布 SLA 或推进 PO。

## 39. 2026-08-31 Drafted Emails 官网桌面双卡收口

- 重新核对 Navisight `drafted-emails` 1920×1080 公开资产。Readywork 保留 Pending / All、左侧草稿队列和右侧邮件审核的双栏骨架，但将原先共享外框收口为两张独立白色圆角卡片；两卡之间固定 20px，不增加第三栏、手机抽屉或底部操作条。
- 页面标题使用 26px、`line-height: 1.15` 的紧凑桌面密度；Notifications 与 Drafted Emails 都隐藏官网不存在的全局搜索，其他已有业务页的真实搜索能力不受影响。
- 左侧队列、右侧主题、决策依据、PO / 供应商 / 承诺日、正文、批准并发送 / 编辑 / 丢弃和审计时间线全部继续读取真实 API / SQLite。批准、编辑、丢弃、检查回信与运行 SLA 仍是显式动作；本轮浏览器只读验收未点击任何动作。
- 1280×720、1440×900、1920×1080 登录态实页均无 `[role=alert]`、无全局搜索、无页面级水平溢出；标题实际行高约 29.9px，两张卡片间距均为 20px。正式 P00021 和 `supplier@supplysentry.invalid` 草稿证据可见。
- 验收前后正式 SQLite 均保持沟通草稿 `draft=3`、草稿事件 3、Outbox 仅 4 条历史 `dispatched`。全仓 `556/556`、根 TypeScript、全 Console ESLint 和 Next.js 16.3.3 production build 全部通过；生产构建前发现的损坏 `.next/dev` 生成缓存已移到 `/tmp`，未修改业务源码或数据。
- 当前 V1 只交付桌面网页版。手机导航、移动草稿队列、邮件详情抽屉、底部操作条和小屏重排全部延期；真实 PO 五阶段、正式 SLA、路线证据和最终 GRN 继续是发布门槛。

## 40. 2026-08-31 Local / Import 官网桌面路线工作台收口

- 重新核对 Navisight 当前公开应用静态包。Local / Import 不再使用 5 张 KPI、风险圆环和执行阶段仪表板作为主骨架，改为官网可验证的“左侧 Navi Assistant + 右侧 PO 表格工作台”两栏：默认左栏 380px、间距 20px，助理可展开、关闭和恢复。
- 左栏没有伪造 route-wide Chat。Readywork 现有上下文聊天仍必须绑定具体 PO；路线页因此只显示来自 `GET /api/procurement/workbench` 的真实路线运营摘要、风险、未分类 PO 与可核验证据，并在文案中明确这是事实助理。26 张未分类 PO 的“确认路线”继续调用既有版本化路线 API、受控文件 / ERP 证据、权限和追加审计。
- 右栏按 Local 与 Import 使用各自的真实阶段页签；工具条包含 PO / 供应商 / 物料搜索、风险、供应商、要求到货日和 CSV 导出。表格固定 10 列、最小宽度 1140px、每页 10 条；页面本身不产生水平溢出，窄桌面只允许表格内部滚动。
- Local / Import 已加入 integrated Header，隐藏官网该页不存在的全局搜索。路线证据治理与 Import Documents 未被删除，而是降为主工作台之后的渐进披露层；上传、ClamAV、绑定、撤销、版本冲突和路线退回未分类仍走原真实纵切。
- 1280×720、1440×900、1920×1080 登录态实页均无业务 `[role=alert]`，页面 `scrollWidth === clientWidth`。左栏三档均为 380px；右栏分别约 556 / 726 / 1206px，1920 桌面无需表格内部横向滚动。Local 与 Import 均诚实显示 0，未分类队列显示 26。
- 全仓 `559/559`、根 TypeScript、全 Console ESLint 和 Next.js 16.3.3 production build 全部通过。验收前后正式 SQLite 保持活跃 PO 26、路线确认 0、草稿 3、Outbox `dispatched=4 / active=0`；没有确认路线、发送邮件、写 Odoo、创建运输 / 收货事实或推进 PO。
- 当前 V1 仍只交付桌面网页版。手机路线卡片、移动 PO 表、抽屉、底部操作栏和小屏重排全部延期；真实 PO 五阶段、正式 SLA、路线证据和最终 GRN 继续是发布门槛。

## 41. 2026-08-31 Suppliers 官网桌面主数据工作台

- 通过公开应用静态包复核 Suppliers 页的真实桌面合同：页头主操作、搜索 / 状态筛选、11 列主数据表、10 条分页、供应商详情弹窗，以及同页 `Material Lead Times (SLA)`。Readywork 删除原五 KPI 仪表盘，改为该单表工作台骨架。
- 主表不伪造 Country、Material、Route、Type、Lead Time 或 On-time Delivery。主数据来自 `GET /api/procurement/suppliers`；物料 / 路线 / 标准交期来自 `GET /api/po/lead-times`；准时交付与执行风险来自持久化供应商绩效快照。没有证据的列显示 `—` 或“证据不足”，不从供应商名称、币种或 PO 状态推测。
- 添加供应商、同步 Odoo 主数据、刷新绩效、物料交期创建 / 编辑 / 退役均保留原真实 API、RBAC、幂等、乐观锁和追加审计。页面加载使用 `Promise.allSettled`；绩效或交期读模型单独失败时仍显示真实主数据并明示降级，不把整页伪装成空数据。
- 1280×720、1440×900、1920×1080 登录态实页均无业务 `[role=alert]`、无 Next 错误覆盖、无页面级水平溢出，控制台 0 error。前两档只在 1240px 表格容器内水平滚动，1920 无内部溢出；三档均显示 10 条真实 Odoo 供应商行，详情弹窗的主数据、执行表现和关联 PO 均可见。
- 正式 SQLite 验收后保持供应商 12、物料交期 0、交期审计事件 0、Outbox `dispatched=4 / active=0`。本轮没有点击同步、刷新绩效、添加供应商或新增交期，没有发送邮件、写 Odoo 或推进 PO。
- V1 只验收桌面 Web 的 1280×720、1440×900 与 1920×1080。手机供应商卡片、移动筛选抽屉、底部操作条和小屏重排继续延期。

## 42. 2026-08-31 Configuration 官网桌面信息架构收口

- Configuration 从“把所有运维面板顺序铺开”改为 Navisight 公开应用骨架：`General Settings` 管理国家、工作日、IANA 时区和日期格式；`Agent Setup` 集中展示 Email、WhatsApp、ERP/Odoo 和供应商可见联系人；`Advanced Governance` 渐进披露发布就绪、部署模式、文档门禁、安全事件和连接器控制面。
- 新页面只组合既有真实组件和 API，没有平行状态。租户偏好继续使用 `PUT /api/procurement/tenant-preferences` 的权限、乐观锁、版本和追加审计；连接卡仍从 Connector 安装、加密凭据与真实测试结果派生。
- 没有可发布后端合同的“排除节假日”不再显示可点假开关；SLA 升级与催交规则深链独立 SLA 工作台。顶部主操作是真实读取的 V1 就绪核验，不伪装为一次全局保存。
- 登录态 1280×720、1440×900、1920×1080 三档验收均有 `scrollWidth === clientWidth`，默认与展开 Advanced Governance 后均无业务 `[role=alert]`、无 Next 错误覆盖、Console 0 error。三通道中真实验证数为 `2/3`：Email 和 ERP/Odoo 已验证，WhatsApp 未配置；专业联系人未配置时依然阻断外发。
- 新增 Configuration 边界测试后全仓 `565/565`、根 TypeScript、修改文件 ESLint 和 Next.js 16.3.3 production build 均通过。浏览器只执行 GET 和本地 disclosure；正式 SQLite 仍为租户偏好 0、偏好事件 0、交期模板 0、交期事件 0、Outbox `active=0 / dispatched=4`，没有保存配置、发送邮件、测试外部连接、写 Odoo 或推进 PO。
- 当前 V1 只交付桌面网页版。手机配置卡、移动抽屉、底部操作条与小屏重排全部延期。

## 43. 2026-08-31 SLA 官网桌面规则表收口

- Navisight 公开静态包 `/tmp/navisight-app-page-20260831.js` 的 `function r6()` 已验证基础 SLA 的完整桌面骨架：`SLA` 标题与说明、`Add New Rule`、搜索、`Applies To / Status` 筛选、规则表和 `Showing X of Y entries` 计数。规则表固定七列语义：Process / Stage、Description、SLA Target、Grace Period、Escalation After、Applies To、Status；最小桌面表宽为 1040px。
- Readywork 主视图已按该骨架重构，但不复制 Navisight 演示行。页面读取正式 SQLite 中唯一的 v2 草稿和 5 条真实阶段规则；`GRN` 搜索可收敛到 1 条，Draft / Active / Inactive 均按持久化事实呈现。
- `Add New Rule`、复制和移除都进入现有版本化草稿合同。复制 / 移除先形成明确的未保存本地草稿，只有保存成功才持久化；页面不会提前显示成功，也不会绕过权限、版本、幂等和追加审计。
- 发布影响、自动检查、评估、退役、运行证据和审计时间线没有被视觉对齐删除，而是收入默认折叠的 `Policy Governance & Runtime`。正式 SLA 尚未发布，因此 V1 readiness 仍不得宣告完成。
- 登录态 1280×720、1440×900、1920×1080 三档均无页面级横向溢出、业务 `[role=alert]` 或 Next 错误覆盖；1280 只允许 1040px 规则表容器内部横向滚动，1440 与 1920 无需表内滚动。新建干净标签页复核 Console 0 error。
- 新增 SLA 视觉边界测试后，全仓 `568/568`、根 TypeScript、全 Console ESLint 和 Next.js 16.3.3 production build 均通过。浏览器只执行 GET、搜索、筛选和 disclosure；正式 SQLite 保持策略 `draft=1 / published=0 / retired=0`、v2 规则 5、策略事件 2、评估 0、自动运行 0、Outbox `active=0 / dispatched=4`。
- Navisight V1 继续只交付桌面网页版，唯一视觉验收视口为 1280×720、1440×900、1920×1080。手机导航、移动规则卡、筛选抽屉、底部操作栏和小屏重排全部延期。

## 44. 2026-08-31 SLA Add/Edit 弹窗与行尾操作对齐

- 继续读取 Navisight 公开静态包 `function r6()`：七个业务列之后还有一个无标题操作列，默认显示 Edit 图标与 More actions；菜单提供 Edit rule、Duplicate、Delete，Add / Edit 使用居中弹窗而不是跳转到另一张大型治理表。
- Readywork 已将规则目录收口为同一桌面交互：每行显示 Edit 与 More actions，菜单提供 Edit rule、Duplicate，以及语义诚实的 Remove from draft / Create removal draft；Add New Rule 和 Edit Rule 均打开 768px 居中弹窗。
- 弹窗没有弱化 Readywork 的规则模型，仍可编辑阶段、路线、风险、期限基准、计时日历、沟通通道、跟进类型、升级角色、目标 / 预警 / 宽限 / 跟进间隔 / 次数和启用状态。发布影响、评估和审计继续留在治理层。
- 已存在 v2 草稿时，Add / Edit / Duplicate / Remove 先修改浏览器内未保存草稿，并明确要求点击“保存草稿”后才写 SQLite；没有草稿时才通过真实 API 创建新的版本化草稿。针对已发布规则的移除只创建 removal draft，绝不物理删除当前正式策略。
- 1280×720、1440×900、1920×1080 三档弹窗均为 768px、页面 `scrollWidth === clientWidth` 且无业务告警。1280 下弹窗高 688px，正文使用自身滚动；1440 下高 868px；1920 下内容完整显示。取消 Add / Edit 后仍为 `Showing 5 of 5 entries / Draft v2 · Saved`，Console 0 error / warning。
- 定向 SLA 交互测试 `5/5`、全仓 `570/570`、根 TypeScript、目标 ESLint 和 Next.js 16.3.3 production build 全部通过；3001 / 4173 / 4174 health 均为 200。正式 SQLite 保持 `draft=1 / published=0 / retired=0`、v2 规则 5、策略事件 2、评估 0、自动运行 0、Outbox `dispatched=4 / active=0`。
- 本纵切只改变桌面 Web 交互；没有保存规则、发布 SLA、运行评估、生成草稿消息、发送邮件或写 Odoo。手机规则编辑器和移动操作菜单继续延期。

## 45. 2026-08-31 Risk Dashboard 高风险 PO 快照明细

- 从 Navisight 当前公开应用静态包复核到 Risk Dashboard 在两排三栏图表之后还有 `High Risk Purchase Orders` 九列表和五维风险说明。Readywork 已补齐 PO 编号、供应商、风险等级、评分、驱动因素、RIHD、币种金额、下一步和对象操作列，不复制官网演示 PO 或单一美元金额。
- 新风险快照在不可变 JSON 中冻结 `riskFactors`、`requiredInHouseAt` 和 `nextAction`；表格、CSV 与 PO 深链读取同一快照对象。旧快照没有后增字段时显示 `—`，不以当前 PO 反填历史。
- 高风险行依快照分数、逾期天数与 PO 编号稳定排序，最多显示 10 行；点击真实 `P00020` 已进入同一 PO 的完整执行上下文，URL 保留 `returnTo=risk-dashboard`。
- 1280×720 下页面 `scrollWidth === clientWidth === 1270`，964px 表格容器内部滚动到 1120px；1440×900 与 1920×1080 下表格容器分别为 1124px / 1604px，无页面级水平溢出。三档均无业务告警，浏览器日志无 error / warning。
- 定向验证 `6/6`、全仓 `573/573`、根 / Console TypeScript、目标 ESLint 和 Next.js 16.3.3 production build 全部通过。验收后正式 SQLite 仍为风险快照 2、Outbox `dispatched=4`、SLA `draft=1`；没有点击更新快照、发送邮件、写 Odoo 或发布 SLA。
- 当前 V1 仍只交付桌面网页版；手机高风险卡片、移动表格、抽屉和底部操作栏全部延期。真实 PO 五阶段、正式 SLA、路线证据和最终 GRN 仍是整体 V1 发布门槛。

## 46. 2026-08-31 Advanced SLA 官网桌面工作区收口

- Navisight 公开静态包中的 Advanced SLA 已固化为独立桌面信息架构：`Advanced SLA Settings` 标题与说明、左侧 section 导航、右侧当前领域工作区、Search / Status / Template / Upload CSV / Add Rule 工具条，以及 Rules / Validation Results / Upload History / Version History 四页签。Readywork 已按该骨架重构，删除五张 Summary Card、Manual / CSV 模式切换和九域纵向 accordion。
- 九个领域仍读取同一 Advanced SLA API 与版本化 profile。Rules 只显示当前领域的真实规则；正式库无 profile 时继续显示真实空态和创建草稿入口，不为页面密度制造示例规则。当前影响计数仍为 26 张活跃 PO、0 张匹配 PO。
- Add / Edit 使用居中桌面弹窗，但修改只保留在现有 `EditorState`，直到 Save draft 的版本化 PATCH 成功才持久化；取消会恢复原规则或移除尚未保存的新规则。CSV 使用独立上传弹窗，先生成真实持久化 preview，再以 batch / profile 双版本应用。Validation、Upload History、Version History 分别读取本地校验、持久化导入失败、导入历史和审计事件。
- Profile 元数据、auto-send allowlist、发布、退役、kill switch、精确候选影响、权限和就绪门禁没有因视觉重排而删除；它们被收拢进 Policy settings、左侧状态区和明确治理动作。页面访问、切换领域 / 页签、筛选和打开弹窗均不发送邮件、不写 Odoo、不发布策略。
- 登录态 1280×720、1440×900、1920×1080 三档均显示 9 个 section 和 4 个页签，页面 `scrollWidth === clientWidth`，浏览器日志 0 error / warning。正式库仍为无 Advanced SLA profile、无发布版本、无导入历史和无版本事件；本轮没有创建草稿、上传 CSV、发布、退役或切换运行状态。
- Advanced SLA 定向测试 `25/25`、全仓 `576/576`、根 / Console TypeScript、目标 ESLint 与 Next.js 16.3.3 production build 全部通过。当前 V1 只交付桌面网页版；手机领域导航、移动规则卡、筛选抽屉、底部操作栏和触屏交互全部延期。

## 47. 2026-09-01 公开产品页后半段桌面收口

- Risk visibility 改为 1360px 标题容器与居中的 1160px 产品图。1920 桌面下标题 x≈275px、主图 x≈376px，标题、说明、主图与 section 底边的纵向位置和官网误差控制在约 1px；不把公开看板中的 PO、金额或风险值写入正式 SQLite。
- Customer value 使用官网 1360×495px 转换卡：左右 601×360px 面板、中央箭头、团队头像、手工通道标签、Navisight agent、四条阶段状态和 61px `Same Team, Greater Capacity.` 页脚。下方 KPI 与 Local / Import 风险图继续使用公开资产，业务工作台仍只读取真实 API。
- FAQ 七项默认全部收起，使用 chevron 展开，不再把第一项强制展开。问题结构对齐官网；答案继续按当前部署的真实身份、邮箱模式、安全门禁和差异处置能力收紧，不复制尚未被本部署证明的绝对承诺。
- Demo 改为 1360px、`.9fr / 1.08fr` 双栏和 64px 间距。1920 / 1440 下表单卡约 707×730px，1280 下约 623×730px；字段、校验、幂等键、SQLite 单事务和审计合同没有变化。官网地址、电话、“一个工作日回复”、认证和法律正文没有冒充为本产品事实。
- 1280×720、1440×900、1920×1080 的后半页均无页面级横向溢出；FAQ 无默认展开，Customer value 面板无裁切。产品页边界测试 `2/2`、Console TypeScript、目标 ESLint 与 Next.js 16.3.3 production build 均通过。手机端、移动导航、抽屉、底部操作栏、触屏手势和小屏重排继续延期。

## 48. 2026-09-01 Privacy / Terms 桌面公开页纵切

- 实时复核发现 Navisight Footer 已从历史 `#` 占位更新为 `/privacy` 与 `/terms`。两页共享 64px 顶栏、Legal Hero、Effective / Last updated、左侧编号 `On this page` 目录、右侧长文 Article 和法律页脚；这一公开变化取代第 24 / 47 节中的旧占位判断。
- Readywork 新增无需采购会话即可访问的 `/privacy` 与 `/terms`，并将产品页 Footer 改为真实链接。`AuthGate` 的公开白名单只增加这两个精确路径，不扩大业务 API 或其他内部页面的匿名访问面。
- 本地正文没有复制 Navisight 的 Dubai / Colombo、`hello@navisight.ai`、Resend、管辖或公司责任条款；它只披露当前可从代码证明的 Demo SQLite / 追加事件、HttpOnly Cookie、租户隔离、连接器门禁、附件安全、AI 人工监督和外部资产请求。页面醒目标注 Pre-release，正式运营主体、联系人、保留期、处理商、管辖和商用合同仍待法律审批。
- 1280×720、1440×900、1920×1080 的 Privacy 与 Terms 均不挂载登录页、无业务 `[role=alert]`、各显示 10 项目录且 `scrollWidth === clientWidth`；Product Footer 的 Privacy / Terms 链接也已在 1920 桌面只读验证。浏览器验收未提交 Demo 或触发任何业务 / 外部写动作。
- 新增法律页边界测试后，定向 `5/5`、全仓 `585/585`、根 / Console TypeScript、全 Console ESLint 和 Next.js 16.3.3 production build 全部通过；构建静态生成 `/privacy`、`/product` 与 `/terms`。手机法律页、移动目录和小屏重排继续延期。

## 49. 2026-09-01 Employee Pack V1 边界与桌面 Web 生命周期

- `capability:procurement` 与 `spec:procurement` 统一升级为 `1.0.0`，产品所有权明确冻结在 `PO Sent → Supplier Commitment → Production → Dispatch / Transit → GRN`。采购需求、寻源 / RFQ、发票 / 应付和三单匹配代码继续作为后续 Employee Pack 资产保留，但不再进入本 Pack 的业务导航、工作流目录或发布快照。
- Employee Pack Manifest 新增可序列化 `lifecycle` 合同：五个阶段均声明稳定 ID、桌面标签、业务说明与负责工作流。员工详情页直接读取该合同显示五阶段条，并明确标注“桌面 Web · 1.0.0”；没有用前端常量复制第二套生命周期。
- Procurement Editor 初始版本改为 `v1.0.0`，活动流程只包含 `po-operations`、`supplier-followup`、`delivery-receipt`。节点目录由 Manifest 的 `nodeTypeIds` 白名单生成，RFQ、报价、发票和三单匹配节点不再作为 V1 新建能力出现。
- 旧控制面草稿、版本和运行记录不做破坏性删除。历史 RFQ / AP 草稿继续原样保存在 SQLite，并可被既有迁移工具读取；活动列表、发布和回滚只操作当前 Pack 声明的三条流程，避免一次 V1 回滚误删历史资产。
- 三条默认流程已补成与五阶段一致的桌面流程图：供应商确认差异经过审批与 ERP 回写，生产风险通过独立邮件工具真实外发，部分 / 全部发运进入运输跟踪，部分收货累计到最终 Odoo / WMS GRN 后才关闭执行链。页面和目录变化不代表正式 PO 已推进，也没有发送邮件、写 Odoo、发布 SLA 或制造业务记录。
- 当前 V1 只交付 1280×720、1440×900、1920×1080 桌面网页版。原生 App、手机导航、移动抽屉、底部操作栏、触控手势和小屏重排全部延期，不进入本次完成率。
- 正式租户的显式迁移入口已经补齐。`GET /api/editor/blueprint-upgrade` 只读返回 Pack ID / 版本、当前与目标修订及逐流程节点 / 连线差异；`POST /api/editor/blueprint-upgrade` 必须同时提交 `confirm: true`、三条流程的 `expectedRevisions` 和幂等键。写入使用 `BEGIN IMMEDIATE`，先把完整 before / after 快照、操作者、请求指纹和结果保存到 `control_workflow_blueprint_imports`，再只替换未发布草稿；修订冲突、幂等键换载荷或任一流程失败都会整笔回滚。导入不会发布、运行流程、发邮件、写 ERP 或改变 PO 事实。
- 正式页面当前真实差异为：采购订单执行 `r1 · 节点 10 → 16 · 连线 10 → 17`；供应商催交 `r2 · 节点 6 → 12 · 连线 5 → 12`；交付与收货 `r2 · 节点 6 → 9 · 连线 5 → 9`。页面的“查看差异并导入”还要求第二次点击“确认备份并导入”；本轮只打开确认层并取消，没有执行导入。
- 隔离临时 SQLite 已通过真实 HTTP 完成保存自定义节点、预览 `upgrade_available`、显式导入、重新读取草稿和最终预览 `current` 的完整持久化验证；观察到草稿修订 `2 → 3`、自定义节点被 Pack 蓝图替换、发布版本数保持 `1`，审计行保留完整 before / after 快照、操作者 `h:procurement-manager` 与 Pack `v1.0.0`。临时 API、数据库和目录已删除。
- 正式 `data/readywork.sqlite` 未被迁移：`control_workflow_blueprint_imports = 0`；三条草稿仍分别为 `po-operations r1 / 10 节点 / 10 连线`、`supplier-followup r2 / 6 / 5`、`delivery-receipt r2 / 6 / 5`。历史 RFQ / AP 草稿也仍在库内，但不会进入 V1 目录、发布或回滚。
- 登录态 Employee 页面已在 1280×720、1440×900、1920×1080 三档稳定态实页复核：`AI Employee · 1.0.0`、五阶段条、V1 迁移提示、三条真实差异和导入入口均可见；页面 `scrollWidth === clientWidth`，未暴露 RFQ、发票或三单匹配节点。确认层取消后正式草稿不变，三档浏览器日志均为 0 error / warning。
- 为消除 Next.js Web 代理复用刚被 API 关闭的五秒空闲连接而产生的偶发 `500 / ECONNRESET`，business / control API 的 `keepAliveTimeout` 已调整为 65 秒、`headersTimeout` 为 70 秒。重启后 `Keep-Alive: timeout=65`，跨旧五秒窗口再次读取 `/api/tasks`、`/api/approvals/pending`、`/api/events` 和 `/api/procurement/tenant-preferences` 均为 200；没有数据写入。
- 根 TypeScript、Console TypeScript、Console ESLint、Next.js 16.3.3 production build 与全仓测试 `590/590` 全部通过；生产构建静态路由为 `/`、`/privacy`、`/product`、`/terms`。

## 50. 2026-09-01 Product Solution 官网桌面几何收口

- 重新按 Navisight 当前公开 `#solution` 实页量测，而不是只凭截图目测。Solution 保持 `96px 32px` 内边距；eyebrow 收口为 12px 深青色；主标题使用 52px / 600 / 1.08 / `-0.03em`、1000px 最大宽度和 balanced wrapping；说明改为 18px / 1.55、720px 最大宽度。
- 产品图不再直接裸放截图。新增 1160px 浏览器外框、40px chrome、20px 圆角、官网同级边框和双层阴影，并补上真实公开 caption：`Navisight drafts the follow-up. Your team approves.`。主图实测为 `1160×726.875px`。
- 补齐原页面缺失的 Solution 下半段：上边距 72px，`5fr / 6fr` 两列和 64px 间距；左侧使用官网公开的供应商沟通定位，右侧继续展示 Overview 浏览器图。1440 桌面下两列实际为 `589.086px / 706.914px`。
- 公开产品页局部改用自托管的开源 `geist@1.7.2`，没有改变中文采购工作台字体。1440 桌面下主标题已稳定为四行、`1000×224.625px`，computed font 为 `GeistSans`；Solution 高度 `1870.8125px`，与官网约 1877px 的实测差异低于 7px。
- 1280×720、1440×900、1920×1080 三档桌面实页均无页面级横向溢出；主图保持 1160px，宽屏两列保持官网几何，浏览器日志 0 error / warning。当前 V1 继续只交付桌面网页版，手机端、移动导航、抽屉、底部操作栏、触屏手势和小屏重排全部延期。
- 本轮只修改公开产品页呈现、视觉边界测试和字体依赖；没有写正式 SQLite、发送邮件、调用 Odoo、发布 SLA、导入 Employee Pack 蓝图或推进任何正式 PO 事实。
- 产品页边界测试 `2/2`、根 TypeScript、目标 ESLint、Next.js 16.3.3 production build 与全仓测试 `590/590` 全部通过；第一次全仓命令被系统 Node 20 的 `node:sqlite` 缺失阻断，已按仓库 `Node >=22` 要求改用工作区 Node 24.19.0 重跑并得到上述全绿结果。

## 51. 2026-09-01 Product How it works 官网桌面几何收口

- 直接在 Navisight 当前公开 `#how-it-works` 实页以 1440×900 量测。官网 section 为 `96px 32px`，内容宽 1360px；标题为 52px / 600 / 1.08、860px 最大宽度；本地此前仍是 104px 纵向内边距、820px 标题和另一套阶段卡样式，现已按实测值替换。
- 五阶段卡已收口为 `1360×181.867px`：20px 圆角、`rgba(15,27,51,.08)` 边框、`#fafbfd` 背景、双层轻阴影和 `40px 36px 28px` 内边距。阶段节点改为 28px `#2ec4b6` 圆点、11.5px 序号、2px 连线；标题为 15.5px / 24.025px，说明为 13.5px / 20.925px，不再使用旧白卡与横向 flex 线段拼法。
- 下半段改为官网 `5fr / 6fr`、64px 间距和垂直居中。1440 桌面下两列实际为 `589.086px / 706.914px`；左侧三条说明为 18px 细线勾选、15px / 24px 正文和 16px 纵向间距；右侧时间线图框为 `560×340.281px`、14px 圆角与官网双层阴影，并补上官方 caption `A live PO advancing through the five stages.`。
- 时间线图改用官网当前 640px 响应式资源，实际图片为 `558×338.281px`，不再请求 1920px 版本。alt 完整描述五阶段状态；公开图片只用于营销页，不作为 Readywork 正式 PO 事实。
- 产品公开页根排版同步为官网 15px / 1.55 / `-0.003em`，Eyebrow 改为 inline 12px / 1.55、`#157f75`。因此 Solution 在 1440 / 1920 下的实测高度也由 1870.8px 收敛到 1876.71px，与官网约 1877px 的差异低于 1px。
- 1280×720、1440×900、1920×1080 三档本地实页的 How it works 均高 `1023.859px`，没有页面级横向溢出、业务告警或浏览器 error / warning；官网同视口实测约 `1024.859px`，剩余差异约 1px。产品页边界测试 `2/2`、根与 Console TypeScript、目标 ESLint、Next.js 16.3.3 production build和全仓测试 `590/590` 全部通过。
- 本纵切只修改桌面公开 Web 样式、图片分辨率与视觉边界测试；没有写正式 SQLite、发送邮件、调用 Odoo、发布 SLA、导入 Employee Pack 蓝图或推进任何正式 PO 事实。手机端、移动导航、抽屉、底部操作栏和触控交互仍不在 V1 范围内。

## 52. 2026-09-01 Product Risk visibility 官网桌面几何收口

- 直接在 Navisight 当前公开 `#risk-visibility` 实页以 1440×900 量测。官网 section 为 `96px 32px`、顶部 `rgba(15,27,51,.08)` 分隔线、1360px 内容宽；本地原实现仍是 104px / 96px 非对称留白、15px 副标题和无浏览器外框的裸图，现已全部替换。
- 标题组按官网收口为 207.461px 高并保留 56px 下间距：Eyebrow 为 12px / 600 / `0.12em`；主标题为 52px / 600 / 1.08 / `-0.03em`、880px 最大宽度和 balanced wrapping，末句使用 `#66738a` 次级颜色；说明为 18px / 1.55 / `-0.005em`、720px 最大宽度。
- 风险图改为共用的 `BrowserShot`：1160px 外框、40px chrome、20px 圆角、`rgba(15,27,51,.14)` 边框与官网双层阴影。1440 下图框实测 `1160×693.375px`，内部图片 `1158×651.375px`；资源改用官网当前响应式 `w=1200` 版本，不再请求 1920px 版本。
- 1440 桌面下本地 section 高 `1149.836px`，与官网实测一致；标题 `880×112.313px`、标题组 `1360×207.461px`、图框 `1160×693.375px` 逐项相等。公开风险图及其 210 POs / `$2.85M` 文案只用于营销页 alt 与视觉说明，不写入 Readywork 正式采购数据。
- 1280×720、1440×900、1920×1080 三档实页均无页面级横向溢出或业务 `[role=alert]`；图框在三档均保持 1160px，section 与关键标题几何稳定。产品页边界测试 `2/2`、根与 Console TypeScript、目标 ESLint、Next.js 16.3.3 production build和全仓测试 `590/590` 全部通过。
- 本纵切只修改桌面公开 Web 样式、图片分辨率、视觉边界测试和对齐文档；没有写正式 SQLite、发送邮件、调用 Odoo、发布 SLA、导入 Employee Pack 蓝图或推进任何正式 PO 事实。V1 继续只验收 1280×720、1440×900、1920×1080；手机端、移动导航、抽屉、底部操作栏、触控手势和小屏重排全部延期。

## 53. 2026-09-01 Product Customer value 至 Footer 桌面几何收口

- Customer value 已改为与 Navisight 当前公开页同构的转换卡：左右 601px 面板、44px 中央箭头列、精确通道 SVG、背景连线、团队头像、手工通道标签、Navisight agent、四条阶段状态和 61px 页脚；不把卡片中的营销示例写入 Readywork 正式采购数据。下方 KPI 资源使用当前 `w=1200` 版本，Local / Import 使用 `w=640` 版本。
- Why Navisight 收口为 880px 居中宣言、26px 三行正文；1440 桌面下区块实测高 `261.445px`，与官网当前实页一致。FAQ 使用七行默认关闭状态、64.5px 行按钮和 1px 分隔线，区块实测高 `798.906px`；回答仍按 Readywork 当前可证明能力收紧，不复制无法验证的绝对承诺。
- Demo 使用官网 `5fr / 6fr` 双栏、64px 间距；左侧信息区约 `580.242px`，右侧真实申请表单卡约 `730.164px`，section 实测高 `922.164px`。提交继续调用 `/api/public/demo-requests`，使用幂等键、SQLite 单事务和追加审计；只有服务端确认持久化后才显示成功，表单不会发送供应商邮件、写 ERP 或推进 PO。
- Footer 按官网桌面几何收口为 `712.398px`。Recognition 位置没有冒充 UAE Startup Story、地址、电话、邮箱、认证或法律身份，改为 Readywork 自己的 `Navisight Procurement Employee Pack · V1` 产品标准卡；Privacy / Terms 继续指向本地真实公开页。
- 1280×720、1440×900、1920×1080 三档桌面实页中，Customer value 均高 `1495.25px`，FAQ 均高 `798.906px`，Demo 均高 `922.164px`，Footer 均高 `712.398px`；三档均无页面级横向溢出和业务 `[role=alert]`。1440 实页截图也已确认表单、留白、卡片边界和桌面 Header 正常。
- 产品页边界测试 `2/2`、根 TypeScript、Console TypeScript、目标 ESLint、Next.js 16.3.3 production build 与全仓测试 `590/590` 全部通过。本轮没有写正式 SQLite、发送邮件、调用 Odoo、发布 SLA、导入正式蓝图或推进正式 PO。
- V1 范围明确冻结为桌面网页版：1280×720、1440×900、1920×1080。手机端、移动导航、移动抽屉、底部导航、触屏手势和小屏重排全部延期，不计入本版本完成率；产品页前半段 Header、Hero、Connectors band、Problem 与 Gap 仍需单独完成最终逐区块几何审计后，才能宣告整页百分百对齐。

## 54. 2026-09-01 Product 前半页与整页桌面最终审计

- Header 按官网收口为 64px border-box：24px Logo、13.5px / 28px gap 的居中导航和 32px Demo 按钮；本地此前由 64px 子层加 1px 外边框形成 65px，现已消除。产品页有效画布再按官网滚动条占位缩窄 5px，使 1280 / 1440 / 1920 三档的 1360px 容器、Logo、导航、CTA 和居中内容 x 坐标一致。
- Hero 改为 72px 顶部留白、880px 文案容器、80px / `-0.035em` 主标题、32px 状态行、19px 说明、48px 双按钮和 64px 图前留白。Overview 不再使用裸图，改为 1000×703.758px 浏览器外框，并保留 96px section 底部留白；三档 Hero 均约 1287.49px。
- Connectors band 补齐 1px 顶部分隔线、14.5px 标题、22px 间距、七个 49.25px 工具卡、23px SAP / QuickBooks / Gmail / Outlook / Office 365 / WhatsApp / WeChat 官方同构 SVG；section 约 190.72px。图标只用于公开营销页，不代表生产连接器已经安装或通过外部验证。
- Problem 改为官网 96px section padding、980px 平衡标题、`5fr / 3fr / 5fr` 碎片化通道图、280px 精确虚线连接器、五张 63.97px 通道卡、14px 说明和 44px mono 三项损失指标；section 三档约 1285.57px。ERP、邮箱、WhatsApp、WeChat、电话和表格内容继续是公开产品图示，不写入正式采购事实。
- Gap 改为 760px 标题、`5fr / 6fr` 双栏、16px 信号网格、18px 信号说明、带 40px chrome 的 Notifications 浏览器图和 280px AI Summary 叠层。1280 下 section 约 852.883px，1440 / 1920 下约 904px，与官网响应式变化一致；公开信号和图片仍不进入 SQLite。
- Demo 的诚实持久化说明扩展为“成功只在存储后出现；表单不会触发供应商或 ERP 动作”。该文案在 1280 的 560px 表单宽度自然换为两行，使 section 与官网同为 940.914px；在 1440 / 1920 的 646.914px 宽度仍为单行，section 保持 922.164px。没有复制官网无法证明的“一个工作日回复”承诺。
- 最终逐区块差异审计：1280×720 最大绝对 section 高度差 `0.961px`、整页总高度差 `-2px`；1440×900 最大差 `0.953px`、整页差 `-1px`；1920×1080 最大差 `0.914px`、整页差 `-1px`。三档 Header 均 64px，Risk visibility、Why、FAQ、Demo、Footer 多项为 `0px` 差；本地与官网均无页面级横向溢出和业务 `[role=alert]`。
- 视觉边界测试已同步冻结 Header、Hero、Connectors、Problem、Gap、有效画布和 Demo 诚实文案。根 / Console TypeScript、目标 ESLint、Next.js 16.3.3 production build 与全仓 `590/590` 回归均已通过；最终文字和 5px 有效画布收口后再次执行同一组验证。本轮没有写正式 SQLite、发送邮件、调用 Odoo、发布 SLA、导入正式蓝图或推进正式 PO。
- 公开产品页桌面版现已完成 Header 至 Footer 的逐区块实页量测与几何收口。这里的“百分百对齐”仅指当前冻结的 1280×720、1440×900、1920×1080 桌面 Web 信息架构、关键视觉骨架和响应式几何；手机端、移动导航、抽屉、底栏、触控手势和小屏重排仍明确延期，且 Readywork 不冒充 Navisight 的公司、认证、地址、电话、邮箱或法律身份。

## 55. 2026-09-01 正式 V1 阻断项与首笔真实 PO 候选复核

- 再次读取 `https://app.navisight.ai/` 当前公开客户端静态包；2026-09-01 文件大小仍为 `400404` bytes，SHA-256 仍为 `27b04fd659102fc70dd53b76587b8fdcbc2ee9e7c75eaeef9881acd16a8f4d6a`，与 2026-08-31 完全一致。公开导航、SLA、Lead Time、Outbox、Notifications、Suppliers、PO Chat 和 WhatsApp 合同没有出现新的可验证页面差异，因此不为“追新”新增无证据页面。
- 对正在运行的 4173 Business API 与 4174 Control API 执行只读签名会话探针：两面 `/api/auth/me` 均为 200；`/api/operations/v1-readiness` 为 `blocked · 7/11`。当前已就绪的是 SMTP、IMAP、Odoo、ClamAV、Temporal / Outbox、Manufacturing Context 和安全事件；四项阻断精确为供应商可见具名采购身份、已发布 SLA、真实本地 PO 和真实五阶段闭环。
- 正式组合当前共有 32 张 PO、26 张活跃 PO、0 张 Local、0 张 Import、26 张未分类，五阶段完整闭环仍为 0。工作台累计 6 条真实 Communication、4 张真实发票，但 0 张结构化 Confirmation、0 条 Production Progress、0 张 Shipment、0 张 Receipt / GRN；测试通过不能替代这些正式事实。
- `P00021` 是当前唯一同时具有真实供应商入站回信和可继续核对的 PO：供应商为“上海卓越阀门”，PO 为 300 Units `过滤器 FL-40`、基准单价 `USD 80`，当前处于 Supplier Commitment。两封真实回信都经过引用原邮件排除；较新的回信可确定性提取 `150 Units` 与承诺日期 `2026-08-10`，但没有可靠单价，必须由人核对是否仍为 `USD 80` 后才能登记结构化确认。
- `P00021` 没有 Incoterm、供应商国家 / 地址或已扫描合同附件，不能因为供应商名称中含“上海”就自动判为 Local。路线确认必须由采购经理选择 Local / Import 并绑定 ERP / 合同 / Incoterm 证据，或填写真实人工复核记录号与判断说明；当前没有写入路线分配。
- 本轮只读审计没有配置或猜测采购联系人，没有发布 SLA，没有登记 Confirmation、创建审批、生成跟进草稿、发送邮件、写 Odoo、创建 Production Progress / Shipment / Receipt，也没有改变正式 SQLite。下一步需要业务负责人明确供应商可见姓名 / 职位 / 公司、批准 SLA 发布、确认 `P00021` 的路线证据，并核对回复中的单价；这些决定完成后才可安全启动真实五阶段闭环。

## 56. 2026-09-01 桌面 Web 范围冻结与 WhatsApp 断开合同

- V1 范围再次明确为桌面网页版，只验收 1280×720、1440×900 与 1920×1080。手机导航、移动抽屉、底栏、触屏手势和小屏重排全部延期，不进入当前完成率或发布判断。
- Configuration 的连接器凭据卡新增真实断开入口。WhatsApp 使用“断开账号”，其他连接器使用“删除凭据”；操作必须经过居中确认层，明确说明只删除 Readywork 加密凭据，不撤销 Meta 端账号、不删除历史消息或审计记录，也不修改外部业务数据。
- Web 只有在 `DELETE /api/editor/credentials/:id` 返回成功后才关闭确认层、刷新连接器 / 凭据 / 事件并显示成功；网络、权限或服务端失败会保留确认层并展示错误。重复删除返回 404，不产生假成功。
- API 成功合同补充 `connectorId`、`credentialId` 与 `disconnected: true`。删除仍以当前会话租户为边界；连接器随后重新计算为 `credentialReady=false`、`externalVerified=false`、`healthy=false`，而 `credential_deleted` 追加审计保留。
- 本轮没有创建 WhatsApp 凭据、调用 Meta、发送消息、写 Odoo、发布 SLA 或推进正式 PO。浏览器新会话因企业身份提供方尚未接入而停在真实登录门禁，没有启用演示认证或认证后门，因此不冒充完成登录态三视口点击验收。
- Connector / Configuration 定向测试 `13/13`、根与 Console TypeScript、全 Console ESLint、Next.js 16.3.3 production build和全仓回归均通过。全仓新增 1 条 Web 边界测试；系统 Node 20 不支持 `node:sqlite`，验证使用项目要求兼容的工作区 Node 24.19.0。

## 57. 2026-09-01 Configuration / Agent Setup 直接连接管理

- 再次下载 `https://app.navisight.ai/` 当前公开客户端静态包，大小仍为 `400404` bytes，SHA-256 仍为 `27b04fd659102fc70dd53b76587b8fdcbc2ee9e7c75eaeef9881acd16a8f4d6a`。公开 Configuration 继续使用 General Settings、Agent Setup、三张通信卡和连接 / 断开操作；没有出现新的可验证页面版本。
- Readywork 的 Agent Setup 已从一张带重复标题和无间距分割线的大面板收口为三张独立桌面卡。每张卡直接显示运行时、凭据、外部验证、最近测试和错误事实；未验证连接使用主操作进入配置，已验证连接直接提供断开与详情，不再要求用户先理解底层 Connector 目录。
- 修复了此前真实交互缺陷：点击“配置 / 测试 / 修复 / 详情”时，Advanced Governance 可能仍处于折叠状态，浏览器会尝试滚动到不可见的 `connector-catalog`。现在先展开高级区，等待 React 提交，再定位选中的 Email / WhatsApp / ERP 连接器。
- Agent Setup 的“断开账号 / 断开连接”复用第 56 节的真实确认、DELETE、刷新和审计合同。Email、WhatsApp 与 ERP 都只删除当前租户的 Readywork 加密凭据；只有服务端确认后才显示成功，历史运行事件保留，外部系统中的账号和业务数据不改写。
- Navisight 公开客户端使用个人 WhatsApp Linked Devices 的 QR / pairing code；Readywork 当前生产合同仍是官方 Meta WhatsApp Cloud API 模板与签名 Webhook。Web 没有伪造 QR、配对码或 live socket；若后续决定增加个人 WhatsApp 通道，必须作为独立连接器经过法律、账号隔离和运行时可靠性评审，不能让 UI 假装现有 Cloud API 已完成个人设备配对。
- 本轮没有断开正式邮箱、WhatsApp 或 Odoo，没有创建凭据、发送消息、写 ERP、发布 SLA 或推进正式 PO。新浏览器会话仍被真实企业登录门禁阻断，因此只完成静态包复核、源码 / 状态合同和自动化验证，不冒充完成登录态三视口点击截图。
- Configuration / Connector 定向测试 `16/16`、根与 Console TypeScript、全 Console ESLint、Next.js 16.3.3 production build和全仓回归均通过；全仓在第 56 节基础上新增 1 条 Agent Setup 边界测试。

## 58. 2026-09-01 Configuration / General Settings 真实策略纵切

- V1 范围继续冻结为桌面 Web，只验收 1280×720、1440×900 与 1920×1080；手机导航、移动抽屉、底栏、触屏手势和小屏重排仍延期。本纵切没有增加原生 App 或手机产品面。
- General Settings 已按 Navisight 公开桌面结构补齐 `Enable SLA Escalations`、`Exclude Weekends`、`Exclude Public Holidays`、`Auto-calculate Lead Time` 四项策略。它们与国家、工作日、IANA 时区和日期格式一起通过同一个租户级 `expectedVersion` 合同保存，不使用 localStorage、假成功或装饰性开关。
- SQLite migration 46 为 `procurement_tenant_preferences` 增加四个布尔列；旧库使用幂等 `ensureColumn` 修复。并发 API / Worker 同时升级时，只有在竞争进程已经形成同一列这一精确后置条件下才吞掉重复 ALTER，其余错误继续传播。每次设置更新仍在单事务中增加版本并追加 before / after / reason 审计，租户和 configure 权限边界不变。
- SLA 自动升级开关是 Worker 的全局门禁。关闭后，普通调度与手工 `force` 都不会领取租约、创建 run 或生成催办草稿；SLA automation 读取面明确返回 `disabled`、`enabled=false` 和设置版本。已有 SLA 策略、评估、草稿和审计不会被删除。
- SLA 工作日使用设置快照而非浏览器时间。`Exclude Weekends` 开启后从明确工作日中排除周六 / 周日；`Exclude Public Holidays` 开启后按国家与 SLA 基准年冻结八年有界的公共节假日日期、国家、年份、数据源、版本和许可。计算正向 / 反向跳过同一日期集合，跨时区与 DST 仍以租户本地墙上时间换算回 UTC。
- 公共节假日来源固定为开源 `date-holidays 3.36.0`，许可为 `ISC AND CC-BY-3.0`；Web 显示来源与许可，SLA 证据保存 `date-holidays`、`3.36.0`、实际日期和年份。国家代码不受该数据集支持时，开启节假日排除的保存请求返回 422，不冒充有可靠日历。
- 自动制造交期开关关闭后，交期主数据仍原样保留，但采购组合不加载模板、不产生 `manufacturing_lead_time_shortfall` 风险。每张组合项与不可变风险快照保留 `autoCalculateLeadTime`、偏好版本和是否继承默认；风险快照水位线加入设置版本，因此设置变化会明确显示为 `configuration_changed`，不会重放旧风险结果。
- Web 使用两列四开关、三列区域字段、七日工作日和配置依据；只有真实 PUT 成功后才更新上下文和提示。409 会重新读取服务器版本，403 / 422 / 500 保留错误态；保存确认明确说明只影响后续计算、不改写既有 ISO 时间戳或历史快照。
- 本轮没有修改正式租户设置、发布 SLA、生成催办、发送邮件、写 Odoo、创建风险快照或推进任何正式 PO。定向回归 `41/41`、全仓回归 `596/596`、根与 Console TypeScript、全 Console ESLint和 Next.js 16.3.3 production build均已通过。
- 当前正式 `data/readywork.sqlite` 已只读确认 migration `46` 与四个策略列全部存在，3001 Console、4173 Business API、4174 Control API 均返回 HTTP 200。新的应用内浏览器会话仍停在“企业身份提供方尚未接入”的真实登录门禁；未开启演示认证、未读取凭据，也不冒充完成 General Settings 登录态三视口点击验收。该视觉复验只覆盖冻结的三个桌面视口，手机端仍不在 V1 范围内。

## 59. 2026-09-01 Configuration / Agent Setup 权限诚实连接摘要

- 重新读取 Navisight 当前公开产品页和 `app.navisight.ai` 客户端。公开应用包仍为 `400404` bytes、SHA-256 `27b04fd659102fc70dd53b76587b8fdcbc2ee9e7c75eaeef9881acd16a8f4d6a`；导航与 Configuration 合同没有变化。公开产品页与本地 `/product` 在同一 1280 桌面下的 11 个 section 宽度完全一致，累计纵向几何误差约 `1.4px`，不需要为了“继续开发”重复改写已经对齐的页面。
- 采购经理登录 Configuration 时发现真实矛盾：顶部 readiness 使用采购侧事实，而 Agent Setup 原来把控制面 403 解释为“Employee Pack 没有返回该连接器”，导致同一页面将已验证的 Email / Odoo 显示为不可用。现在新增 `GET /api/procurement/configuration/connections`，从当前租户 Connector Control Plane 读取真实三通道状态，但只返回 `id/status/runtimeHealthy/credentialReady/externalVerified/credentialCount/healthMessage` 和脱敏凭据测试状态；不返回凭据 ID、名称、字段、动作、密文或安装配置。
- 该只读摘要允许采购经理读取，并显式返回 `permissions.manage=false`；保存凭据、运行真实外部测试、安装和断开仍只走原管理员控制面。Web 对非管理员展示“可查看真实连接状态”的说明，所有连接动作变为禁用的“已验证 · 由管理员管理 / 联系管理员配置”，不会诱导用户点击一个必然 403 的假入口。管理员仍保留原来的真实配置、测试和断开流程。
- 本机验收仅对当前 4173 / 4174 非生产进程显式启用 `READYWORK_DEMO_AUTH=1`，没有写环境文件，也没有启用匿名管理员。采购经理登录态实页显示 Email=已验证（最后测试 08-21 17:29）、WhatsApp=未配置、ERP/Odoo=已验证（最后测试 08-21 17:28），与现有 Connector / 凭据事实一致。
- 1280×720、1440×900、1920×1080 三档桌面实页均为 `scrollWidth === clientWidth`、四个 General Settings switch 完整可见、三张连接卡单行三列且无可见业务 alert。三档卡宽分别约 `308.7px / 362px / 500px`；采购经理下三张动作均为禁用权限态，没有触发测试、断开或其他外部副作用。
- 新增 API 与 Web 边界定向 `11/11`、全仓 `599/599`、根与 Console TypeScript、全 Console ESLint、Next.js 16.3.3 production build全部通过。本纵切没有修改正式租户偏好、凭据、沟通身份、SLA、路线或 PO；没有发送邮件、调用 Meta、写 Odoo 或推进五阶段事实。手机端继续不在 V1 范围内。

## 60. 2026-09-01 Configuration / Advanced Governance 经理只读边界

- 继续以 Navisight 当前公开桌面证据为产品边界：供应商由具名专业联系人沟通、ERP 可选、差异必须交给相关内部人员决定；Readywork 的采购经理因此必须能看到发布门槛，但不应因此获得连接器安装、凭据、运行队列或安全事故处置权限。
- 采购经理展开 Advanced Governance 时复现了三个真实矛盾：`/api/operations/v1-readiness` 返回 403、完整 Connector Control Plane 因管理员接口失败而显示 0、Security Incidents 把管理权限不足显示为红色业务错误。页面把“无权限”误呈现成“没有数据”，与 Agent Setup 已验证 Email / Odoo 的真实状态冲突。
- 控制面现在只把精确的 `GET /api/operations/v1-readiness` 降到 `configure` 权限；它仍是同租户、只读、已脱敏的发布摘要。`/api/operations/readiness`、`/api/operations/security-incidents`、连接器目录、凭据字段、外部测试、安装、断开和事故处置仍要求 `admin`，采购经理和采购专员的边界均有真实 HTTP 集成测试。
- Web 在 Configuration / Tools 先读取第 59 节的脱敏连接摘要。非管理员不再请求或挂载管理员 children，因此不会制造详细运维 403、假 0 指标或空连接器目录；页面改为“管理员治理控制面”只读边界，显示真实 `2/3` 外部验证与 `2` 条脱敏凭据状态，但不返回名称、字段、动作或密文。
- V1 面板仍展示 11 个真实门槛。采购经理可从连接器阻断跳回 Agent Setup；文档运维、可靠运行时和安全事故只显示“管理员治理”，不会提供一个点击后必然失败的动作。联系人、SLA、邮箱 PO 与本地采购等采购经理职责内入口继续可操作。
- 当前正式实页为 `blocked · 6/11`：26 张活跃 PO、0 张 Local、26 张未分类、0 张完整五阶段闭环；阻断项为具名采购身份、正式 SLA、21 个未处置安全事故、真实 Local 路线和完整五阶段闭环。对应 64 条不可变安全原始事件；本轮没有擅自标记修复、接受风险或删除审计。旧页面复现阶段产生的权限拒绝也按既有安全策略追加审计，修复后采购经理稳定页面不再发起这些管理员请求。
- 登录态 1280×720、1440×900、1920×1080 三档均为 `scrollWidth === clientWidth`、0 个可见业务 alert、0 个新标签页 error / warning；Agent Setup 三卡宽仍约 `308.7px / 362px / 500px`，11 门槛桌面网格保持两列，管理员控制面在采购经理 DOM 中不存在而只读边界可见。
- 定向 API / Web 回归 `13/13`、全仓 `599/599`、根与 Console TypeScript、全 Console ESLint、Next.js 16.3.3 production build全部通过。没有发布 SLA、配置身份、确认路线、处置事故、发送邮件、写 Odoo、导入蓝图或推进 PO；V1 继续只验收三个桌面 Web 分辨率，手机端、原生 App、移动导航、抽屉、底栏和触控交互全部延期。

## 61. 2026-09-01 Overview 实时趋势与桌面下半区收口

- 复核真实 Overview 时发现高风险当前值为 14，而持久化历史为 `8 → 9`；旧前端只比较水位前缀，把过期快照末值误当成当前值，错误显示 `+12.5%`。现在新增纯 View Model，精确消费 Risk Dashboard 的 `freshness`：`stale / missing` 时追加当前实时 KPI，`current` 时不重复追加。
- 正式实页趋势现为高风险 `8 → 9 → 14 · +55.6%`、逾期 `8 → 12 · +50%`、需关注 `10 → 14 · +40%`。日期浮层同时显示两个历史快照、PO 事实水位 `08-24 18:20` 与风险评估 `09-01 11:20`，不再把快照创建时间或过期水位冒充当前事实。
- 1920×1080 的 Overview 下半区恢复为 Local 风险卡、Import 风险卡和 318px 行动卡，实页宽度约 `624 / 624 / 318px`。行动卡读取正式 `unclassifiedRoute=26`；点击“审查未分类 PO”只应用 `route=unclassified`，仍返回 26 条真实记录，不确认路线、不修改 PO、不写 SQLite。
- 1280×720 使用 3×2 KPI，路线区约 `473 + 473px`；1440×900 使用六张 KPI 单行，路线区约 `553 + 553px`；1920×1080 的 KPI 卡约 `254.33px`，主执行区约 `1268 + 318px`。三档均为 `scrollWidth === clientWidth`，浏览器 0 error / warning；宽屏隐藏重复未分类告警，1280 / 1440 保留真实告警。
- 新增 Overview 趋势和读 / 视觉边界测试；定向测试 `6/6`、全仓 `602/602`、根 TypeScript、Console TypeScript、全 Console ESLint及 Next.js 16.3.3 production build全部通过。本纵切没有发布 SLA、配置身份、处置安全事故、确认路线、发送邮件、写 Odoo 或推进正式 PO。
- V1 范围继续冻结为桌面网页版，只验收 1280×720、1440×900 与 1920×1080。手机端、原生 App、移动导航、抽屉、底栏、触控手势和小屏重排全部延期，不进入当前完成率。

## 62. 2026-09-01 Employee Pack 流程图可恢复桌面深链

- 真实 3001 复核发现侧栏“小流程图”虽然能进入 Editor，但旧入口只把 `section=employees` 写入 URL；刷新后 `viewMode` 回到默认 business，Employee Pack 所有权门禁会把页面安全重定向到 Overview。因此入口可点击但不可刷新、不可分享。
- 现在流程图入口写入 `section=employees&view=developer`，初始加载与 `popstate` 都从 URL 解析开发者模式。`view` 只接受精确 `developer`；缺失、`business`、未知或畸形值全部回落 business。离开流程图时同步删除 `view`，不让开发者模式污染采购业务页。
- 应用内浏览器已验证三条路径：侧栏点击后 URL 出现 `view=developer` 且 Editor 可见；同 URL 完整刷新后仍停留 `采购执行员工 / Editor` 与 V1 Lifecycle；普通 `section=employees` 自动规范化回 Overview，DOM 中不存在 Editor。全程浏览器 0 error / warning。
- 新增纯解析与 Web 接线边界回归；全仓 `603/603`、根 TypeScript、Console TypeScript、全 Console ESLint和 Next.js 16.3.3 production build全部通过。页面复核没有运行、发布或导入工作流，没有发送邮件、写 Odoo、发布 SLA、处置事故、确认路线或推进正式 PO。
- V1 继续只交付 1280×720、1440×900、1920×1080 桌面网页版。手机流程图、触控画布、移动节点库、抽屉、底栏和小屏重排全部延期。

## 63. 2026-09-01 全局桌面壳收口

- 以 Navisight 当前公开应用 1440×900 实测为准，Readywork 侧栏已统一为 248px 外壳、12px 外留白、224×876px 内卡、24px 圆角、68px 品牌头和 36.25px 导航项；1280 / 1440 / 1920 三档继续共用同一桌面壳。
- 修复根应用壳的 sticky 边界：`overflow-x-hidden` 改为 `overflow-x-clip`。1440 页面滚动至 650px 后，展开态侧栏仍为 `y=0 / 248px`；折叠态为 `y=0 / 76px`、内卡 52px；再次展开恢复 248 / 224px。
- Next.js 左下角开发徽标会覆盖折叠态展开按钮，因此 3001 开发配置已关闭 `devIndicators`。该修复只影响开发 UI，不写正式 SQLite、不发送邮件、不调用 Odoo、不发布 SLA、不确认路线、不处置安全事故，也不推进任何真实 PO。
- 三档实页均为 `scrollWidth === clientWidth`，业务 alert 为 0，浏览器 error / warning 为 0。全局 CSS 不再用 `font: inherit` 覆盖 Tailwind 控件字号、字重和行高，导航视觉密度与公开应用一致。
- 本节确认的交付范围只有桌面网页版。手机端、原生 App、移动导航、抽屉、底栏、触控手势和小屏重排明确后置；它们不计入当前 V1 完成度。

## 64. 2026-09-01 Local / Import 路线助手桌面对齐

- Local / Import 工作台已接入独立的路线级 `Navi Assistant`，但范围仅限桌面 Web。当前 V1 只对齐 `1280×720`、`1440×900`、`1920×1080` 三档桌面视口；手机端、移动抽屉、底部操作栏和小屏重排不在本轮完成定义内。
- Assistant 固定在路线页左列，默认宽度 `380px`，与右侧路线工作区形成 `380px / minmax(0,1fr)` 双栏。展开时改为更宽的桌面双栏，关闭后主工作区占满并保留恢复入口；这些都是桌面信息层级调整，不改变路线、PO、Shipment、单证或 GRN 的真实数据合同。
- 路线助手的会话是持久化的：后端将 conversation、messages、requests 和 audit 落到独立 SQLite 表，前端刷新后继续读取服务端历史，不依赖 localStorage 或前端拼接历史。`Idempotency-Key`、租约恢复、版本冲突和权威 `history` 校验都由服务端执行。
- Local 与 Import 的问答上下文按 `tenant + route + user` 隔离，只读取当前路线的持久化 portfolio 摘要，并将模型上下文限制为该路线前 `32` 条 PO。Local 页面不会读取 Import 组合，Import 页面不会读取 Local 组合，也不会把未分类 PO 冒充已确认路线事实。
- 能力边界继续诚实收紧：已验证文本问答、受治理附件证据、持久化历史、权限态和 `fast / reasoning` 模型分流。Assistant 明确是只读运营核对入口，不发送邮件、不审批、不修改 ERP、不登记运输/清关/收货，也不直接确认路线。
- 路线附件在第 66 节完成真实纵切：服务端仅接受 multipart `file`，只支持 PDF、CSV、XLSX、DOCX、TXT、MD；文件先持久化、扫描、解析并展示状态，只有 `clean + parsed` 的解析文本才在后续轮次进入模型。JSON 伪造附件仍 415，失败或隔离文件只保留审计。

## 65. 2026-09-01 租户级 Odoo 运行时与路线页公开细节收口

- 移除 Business API 启动期从固定 `TENANT_ID` 恢复的 Odoo 单例，新增 `OdooRuntimeResolver`。它只查询当前 tenant 的 `erp / erpCredential`，并同时要求 connector 未停用、credential=`connected`、存在 `last_tested_at`、`last_error IS NULL` 且密文可解密；任何缺口都 fail closed，不回退到环境变量、其他 tenant 或旧缓存。
- Resolver 缓存键包含 credential ID、`updated_at`、测试时间与密文摘要。保存 / 轮换会先回到 untested，删除、重新测试、密文变化、停用和进程重启均有定向测试；采购快照同步、RFQ 供应商主数据、PO / GRN / 发票读取、异常三单读取与 ERP Outbox 已全部接线。Outbox 仍保留冻结业务输入、correlation 幂等、写后核验与结果不确定不重放，只把 `credentialId / credentialVersion / lastTestedAt` 写入安全白名单回执。
- Local / Import 桌面页补齐当前公开细节：`Hello Admin!`、五条路线能力、四个矩形快捷问题、展开→新对话→关闭的控制顺序、单行输入、Filters + RIHD 起止日期、轻斑马纹、真实范围与编号分页，以及关闭后的右下角 Navi Assistant 浮动恢复键。附件入口已在第 66 节接入真实安全链；未接真实 API 的 Send follow-up / Edit RIHD / Mark at risk 仍没有伪造入口。
- 4173 重启后，采购经理 Configuration 继续显示 ERP / Odoo=已验证。登录态执行一次真实 Odoo 供应商主数据只读同步，返回新增 0、更新 0、未变化 10；26 张 PO 因 Odoo 仍未提供可用 Incoterm 或供应商国家 / 地址而诚实保持未分类。SQLite 新增一条 `supplier_master.sync` runtime binding 事件，metadata 只有 action、credentialId、credentialVersion、lastTestedAt，敏感字段扫描为 0。
- 1280×720、1440×900、1920×1080 三档实页的 Local 页面均无全局水平溢出；Assistant 固定 380px，1280 仅 PO 表内部滚动。Filters 可展开真实起止日期，关闭 / 恢复 Assistant 正常，浏览器日志只有 React DevTools info 与 HMR log，0 error / warning；验收后已 reset 临时 viewport。
- 定向 Odoo / Outbox / Sync / Connector / Persistence `40/40`、全仓 `623/623`、根 TypeScript、全 Console ESLint和 Next.js 16.3.3 production build全部通过。本轮只执行 Odoo 只读主数据查询与本地幂等同步 / 审计，没有向 Odoo 写 PO / 发票 / GRN，没有发送邮件、发布 SLA、确认路线、创建运输 / 收货事实或推进正式 PO。
- V1 继续只交付桌面网页版。手机端、原生 App、移动导航、抽屉、底栏、触控手势和小屏重排全部延期，不计入当前完成度。

## 66. 2026-09-01 Local / Import 路线助手真实附件纵切

- 路线助手复用 PO Context Chat 的共享 multipart 读取器、`procurement_attachments`、对象存储 / SQLite、SHA-256、附件版本、ClamAV、文档任务、租户配额和追加审计。新增 migration 48，为 `procurement_route_chat_messages` 增加不可变 `attachment_id` 引用；正式 `data/readywork.sqlite` 已应用并只读核对列存在。
- multipart 合同固定为 `route / conversationId? / expectedVersion / message / history? / startNew? / file?`。文件只允许 PDF、CSV、XLSX、DOCX、TXT、MD，单文件 8 MB、整请求 12 MB；JSON 中携带附件字段仍返回 415。对象存储失败时消息、附件和 request 均不落库；并发失去幂等竞争的临时对象会 best-effort 清理。
- 消息响应持久化文件名、大小、SHA-256、安全状态、解析状态、检测类型和 `readableByModel`。`pending_scan / queued` 只表示已保存；只有 `security_status=clean` 且 `processing_status=parsed` 时，后续轮次才能把解析预览作为不可信证据加入模型。`quarantined / scan_failed / parse_failed` 保留审计但绝不进入模型。
- 桌面 Web 展示待发送文件、等待扫描 / 解析、已扫描并解析、阻断、证据引用和真实解析重试。客户端从服务端能力读取格式与大小；能力在刷新后失效时会阻止发送，不会静默丢附件或降级成纯文本成功。路线切换和新对话会清空原生文件输入，允许重新选择同一文件。
- API / Persistence / Console 定向测试 `36/36`、全仓 `625/625`、根与 Console TypeScript、全 Console ESLint、Next.js 16.3.3 production build全部通过。4173 已精确重启并应用 migration 48；3001 与 4173 均在监听。
- 登录态 Local 与 Import 已做只读浏览器验收。1280×720、1440×900、1920×1080 三档页面级水平溢出均为 0，Assistant 约 378px，附件按钮可用，`accept=.pdf,.csv,.xlsx,.docx,.txt,.md`，可见业务告警为 0；硬刷新后反复切换 Local / Import 没有新增 browser error / warning。验收未选择或上传文件，未调用模型、发送邮件、写 Odoo、确认路线或推进正式 PO。
- V1 范围继续冻结为桌面网页版。手机端、原生 App、移动导航、抽屉、底栏、触控手势和小屏重排全部延期，不进入当前完成度。

## 67. 2026-09-01 Local / Import PO 行尾真实跟进草稿纵切

- 从 Navisight 当前公开静态包可验证到 PO 行尾菜单包含 `View details / Send follow-up / Edit RIHD / Mark at risk`。公开证据只能证明入口与交互骨架，不能证明后三项的执行合同；因此 Readywork 本轮只实现价值最高且后端边界可验证的 `Send follow-up`，没有附加伪造的 Edit RIHD 或 Mark at risk 按钮。
- Local / Import PO 表格新增桌面行尾 `…` 操作菜单和 `查看详情 / 发送跟进`。表格继续使用 V1 既定 `min-width: 1140px`，新 48px 操作列纳入原桌面合同，没有为一个按钮扩大整页最小宽度。
- 跟进确认弹窗显示真实 PO 阶段、风险、RIHD、操作权限和服务端 `queue_followup` readiness。提交必须带 PO `expectedVersion`和 `Idempotency-Key`；版本冲突、缺少具名采购身份、无真实供应商邮箱或权限不足都由服务端阻断。
- 成功操作只在 SQLite 中生成带业务证据的版本化邮件草稿并追加审计事件；不直接发邮件、不写 Odoo、不推进 PO 阶段。用户可从成功态进入 Drafted Emails，人工复核后才能批准进入真实 Outbox。
- 正式 portfolio 已读取 32 张 PO，32/32 具有合法版本和 `queue_followup` readiness；当前 0 张满足所有外发前置门禁，因此页面诚实阻断，验收没有创建正式草稿、发送邮件、写 Odoo 或推进 PO。
- 全仓测试 `626/626`、根 TypeScript、Console TypeScript、目标 ESLint 与 Next.js 16.3.3 production build 全部通过。验收运行时按仓库要求使用 Node 24.19.0；系统默认 Node 20 因缺少 `node:sqlite` 未被用来产生虚假通过结果。
- 登录态 Local 与 Import 均在 1280×720、1440×900、1920×1080 三档实页通过：Assistant 稳定为 380px，表格最小宽度 1140px，操作表头唯一，页面 `scrollWidth === clientWidth`，无可见业务告警、无 browser error / warning。Import 首次读取遇到一次 15 秒前端超时；请求链证明服务端后续返回 200，重新读取后稳定态和三档验收全部通过，页面全程未把超时伪装成空数据。
- V1 范围继续冻结为纯桌面网页版，只验收上述三个桌面分辨率。手机端、原生 App、移动导航、抽屉、底部操作栏、触控手势和小屏重排全部延期，不计入 V1 完成度。

## 68. 2026-09-01 Local / Import PO 行尾人工风险纵切

- 第 65 / 67 节记录的 `Mark at risk` 缺口已由本节后续实现取代。Local / Import 行尾菜单现在按 Navisight 当前公开静态包的可验证顺序呈现 `查看详情 / 发送跟进 / 修改 RIHD / 标记风险`，风险入口位于分隔线之后并使用稳定红色语义；不从公开按钮外观推断 Navisight 未公开的后端行为。
- Readywork 没有照搬公开客户端的单字段 PO 状态覆盖。`POST /api/procurement/execution/mark_at_risk` 要求当前租户、`operate` 权限、活动 PO 状态、`expectedVersion`、`Idempotency-Key`、风险级别、白名单类别和有界事实说明；客户端不能传 `status`、Connector、Odoo 映射或任何外部副作用字段。
- 成功写入在一个 SQLite 事务内形成 `manual_purchase_order_risk` Exception、`purchase_order.marked_at_risk` Activity 和执行幂等回执。事实明确标识 `source=human_mark_at_risk`，历史字段使用“人工标记”措辞，不把人的判断冒充 AI。已有未关闭人工风险时，新键返回冲突；同键同载荷只重放原结果。
- Portfolio、Overview、路线页、Risk Dashboard 与 PO Context 读取同一未关闭 Exception：中 / 高 / 严重风险分别进入 60 / 85 / 100 分风险因素，保留原因、类别、操作者、时间与建议处置；服务端 `actionReadiness.mark_at_risk` 在创建后变为 `already_marked`。该动作不发送邮件、不写 Odoo、不改变 PO 阶段，后续关闭仍必须走统一异常审计链。
- 隔离浏览器验收复制并清理了临时 SQLite，移除凭据、Outbox 与 Worker 待处理项，只为 `P00001` 添加明确标注为隔离验收的 Local 路线。1280×720、1440×900、1920×1080 三档均无页面级水平溢出、无可见业务告警、无 browser error / warning；620px 弹窗、菜单顺序、红色入口、表单门禁、成功态和重复阻断态均通过。
- 隔离真实点击生成 `procurement-risk:a67a29b9-b4cc-4b2d-93e9-cf59aeadb052`，数据库同时存在一条对应 Activity 与一条执行幂等记录；刷新后页面恢复同一 Exception ID 并禁用重复提交。原 PO 继续保持 `confirmed / version 1`，证明风险动作没有推进阶段。正式 `data/readywork.sqlite` 对同一 PO 的人工风险计数仍为 0，未被验收改写。
- 定向 Persistence / API / Workbench / Console 回归 `50/50`、全仓 `634/634`、根 TypeScript、全 Console ESLint和 Next.js 16.3.3 production build全部通过。本纵切没有修改正式路线或业务记录，没有发送邮件、调用 Odoo、发布 SLA、处置安全事故或推进真实五阶段闭环。
- V1 范围继续只交付桌面 Web。手机端、原生 App、移动导航、抽屉、底部操作栏、触控手势和小屏重排仍延期，不进入当前完成度。

## 69. 2026-09-01 PO 详情 Actions / 复制为独立 Draft 真实纵切

- PO 任务详情顶部新增 Navisight Actions 语法下的“操作”菜单；`复制采购订单` 只在服务端 `actionReadiness.duplicate_po.ready=true` 且当前身份具有 `operate` 权限时可用。560px 桌面弹窗展示源 PO、供应商、行数、源版本、新 PO 编号、RIHD、复制原因、幂等请求编号及明确副作用边界。
- `POST /api/procurement/execution/duplicate_po` 要求 `aggregateId / expectedVersion / purchaseOrderNumber / requiredInHouseAt / reason / Idempotency-Key`，拒绝客户端伪造上游关系、ERP 映射和执行历史。单个 SQLite 事务创建 `sourceSystem=readywork / status=draft / version=1` 的独立 PO、全新 PO 行、`po_sent / active` 阶段事件、源与目标双向 Activity 及幂等回执；任一行写入失败时全部回滚。
- 新 Draft 只继承供应商、币种、物料、数量、单价、税务字段和用户明确提交的新 RIHD。它不会继承 Odoo 映射、RFQ / Award / Requisition 上游关系、附件、供应商确认、生产、发运、收货、异常、沟通或执行历史；动作本身不发送邮件、不写 Odoo、不改变源 PO。
- 第一次隔离实页提交真实暴露了一个前端缺陷：事务已创建第 33 张 PO，但 32 张 PO 的权威工作台聚合约需 19 秒，旧 15 秒刷新超时；弹窗又在刷新前关闭，导致错误状态被卸载并仍显示源 P00022。现在 `loadWorkbench` 支持动作级超时，复制操作用 30 秒窗口，并且只有新 ID 已出现在权威工作集后才关闭弹窗、切换选中项、写入深链和显示成功；否则保留弹窗与同一幂等键，不会伪装成功或重复创建。
- 修复后的第二次隔离提交从真实 `P00023 / version 1 / 1 行` 创建 `PO-E2E-DUP-20260901-002`（内部 ID `purchase-order:readywork:8207cfeb-5718-4f9a-8de5-354e75dc91b2`）。页面从 33 增至 34 张并自动打开新 Draft；URL 写入持久化 `poId`，完整刷新后仍恢复同一记录，显示 Odoo“尚未创建”和真实“创建 Odoo 采购订单草稿”下一步，0 个可见业务告警、0 个 browser error / warning。
- SQLite 核对显示源 P00023 文档哈希 `5508614a…a1d8`、源行哈希 `0f352908…3a7e` 在操作前后完全一致；新行 ID 与源行不同，目标只有一条 `draft_created_from_duplicate` 阶段事件，源和目标各一条对应 Activity，且只有一条 `duplicate_po` 幂等记录。目标附件与上游关联文档均为 0。
- 1280×720、1440×900、1920×1080 三档实页的弹窗宽度均为 560px，页面 `scrollWidth === clientWidth`，弹窗完整可见；验收后已恢复浏览器默认视口。隔离栈只在临时 4001 / 4273 / 4274 端口和去凭据 `/tmp` SQLite 上运行；为避免在浏览器传输演示密码，仅隔离进程临时开启本机匿名验收身份，没有写环境文件。
- 正式 `data/readywork.sqlite` 只读复核仍为 32 张 PO、4 条既有执行幂等记录、0 条 `duplicate_po`、0 张上述 E2E PO、P00023 复制 Activity=0，证明验收没有写入正式采购库。最新定向 Web 回归 `3/3`、串行全仓 `638/638`、根与 Console TypeScript、全 Console ESLint及默认 4173 / 4174 Next.js 16.3.3 production build全部通过。首次把全仓测试与生产构建并行运行时，控制 API HTTP readiness 用例因启动争用在 31 秒门槛超时；同一文件随后单独 `4/4` 通过，最终无并行构建的全仓串行回归也为 `638/638`。
- 这条纵切完成的是独立 PO Draft 复制能力，不替代 V1 的具名采购身份、正式 SLA、真实 Local 路线、安全事故处置和五阶段真实闭环门槛；发布 readiness 仍以正式 `blocked · 6/11` 为准。手机端继续延期，不进入当前完成度。

## 70. 2026-09-02 Clean-room Alignment Task 1 依赖与许可证门禁

- Console 的 17 个直接运行/开发依赖已从 `latest` 固定到当前 lockfile 已验证的精确版本；没有借本任务升级 Next.js、React、Tailwind 或其他框架。根 `packageManager` 仍声明 `pnpm@11.7.0`，当前工作区运行时实际提供 `pnpm 11.19.0`，本次 `--lockfile-only` 解析没有改变已解析制品版本。
- 新增 `docs/THIRD-PARTY-LICENSES.md`，登记 17 个 Console 直接依赖和 6 个 API 文档/解析依赖的精确版本、许可、来源、用途、数据外流、生产授权、NOTICE、fallback、负责人和商用放行结论。没有写入凭据、token、合同价格或客户内容。
- TDD 红测命令 `pnpm exec tsx --test apps/console/test/dependency-license-boundary.test.ts` 首次有效运行得到 `0/2` 通过，精确失败于 `@tailwindcss/postcss=latest` 和账本文件不存在；完成最小实现后同一命令为 `2/2` 通过。
- 最终任务验证命令为 `pnpm install --lockfile-only`、`pnpm exec tsx --test apps/console/test/dependency-license-boundary.test.ts`、`pnpm typecheck`、`pnpm --filter @readywork/app-console lint`、`pnpm --filter @readywork/app-console build`。依赖测试 `2/2`、根 TypeScript、Console ESLint 均退出 0；Next.js 16.3.3 Turbopack production build编译成功并静态生成 6/6 页面。
- 本任务只修改依赖声明、lockfile 元数据、测试与文档；没有打开或写入正式 `data/readywork.sqlite`，没有调用 Odoo、Email、WhatsApp、Temporal、Outbox 或任何正式外部连接器，readiness 仍以既有正式事实为准。

## 71. 2026-09-02 Clean-room Alignment Task 2 Pack 品牌与十项 IA

- `PROCUREMENT_EMPLOYEE_PACK` 产品名已固定为 `Readywork Procurement Execution`，主题 ID 为 `readywork-procurement`；生产 Pack 源码不再含参考品牌字符串。十项业务入口由导出的 `PROCUREMENT_BUSINESS_NAVIGATION` 单一常量生成，顺序和英文标签精确为 Overview、Notifications、Drafted Emails、Local、Import、Risk Dashboard、Suppliers、SLA、Advanced SLA、Configuration。
- `orders` 与 `po-intake` 继续保留在业务 ownership 中供 PO 详情和 Configuration 深链使用，但不进入一级导航；开发者接口继续启用、继续只拥有 `employees`，不会混入采购业务导航。
- Core Manifest 校验现只允许导航分组标题为空；业务/开发接口标签和每个入口标签仍必须为非空字符串。Console 导航构造测试确认无标题单组保持原样，且不会把 ownership 深链自动渲染成入口。
- TDD 红测命令 `pnpm exec tsx --test packages/core/test/employee-pack.test.ts packages/supply-chain/test/procurement-employee-pack.test.ts apps/console/test/employee-packs.test.ts` 得到 `7/9` 通过，精确失败于空分组标题仍被拒绝和规范导航常量尚未导出；最小实现后同一聚焦组为 `10/10` 通过。
- 根 `pnpm typecheck` 与 Console `pnpm --filter @readywork/app-console lint` 均退出 0；对 `packages/supply-chain/src/procurement-employee-pack.ts` 的参考品牌扫描为零命中。本任务没有访问正式 SQLite，也没有触发任何外部连接器或业务动作。

## 72. 2026-09-02 Clean-room Alignment Task 3 Console 壳与开发者深链

- Console 壳已统一使用 `readywork-procurement` theme，并把本地实现命名从 `navisightSection` 收口为 `procurementSection`。桌面与移动业务导航均不再追加“流程图/编排”或 Developer 入口；十项页面标题与 PO 返回标签优先读取 Pack Manifest，legacy 标题表只作为非 Pack 兜底。
- `resolveNavigationViewMode` 明确区分业务视图和显式开发者视图。普通 `?section=home` 进入 business；授权用户直接输入 `?section=employees&view=developer` 时 URL 参数保持不变并进入采购执行员工 Editor。验收只读取页面，没有点击模拟运行、影子运行、审批运行、自动运行、发布、保存或任何工作流动作。
- Chrome 登录态在 1280×720、1440×900、1920×1080 三档逐一验收。三档侧栏均精确显示 Overview、Notifications、Drafted Emails、Local、Import、Risk Dashboard、Suppliers、SLA、Advanced SLA、Configuration，Flow/Developer 可见项均为 0，页面级横向溢出均为 `0px`；验收后已恢复默认视口。
- 开发者深链页面的应用来源浏览器诊断为 `0` error、`0` warning。另观察到 2 条 `chrome-extension://` 来源的 Extractor JSON 解析错误，属于 Chrome 扩展自身而非 `http://127.0.0.1:3001` 应用资源，已按来源排除并保留说明。
- 聚焦命令 `pnpm exec tsx --test apps/console/test/app-shell-visual-boundary.test.ts apps/console/test/employee-packs.test.ts apps/console/features/procurement/navigation-state.test.ts` 最终为 `14/14`；根 `pnpm typecheck` 与 Console `pnpm --filter @readywork/app-console lint` 均退出 0。Next.js 16.3.3 production build 编译成功并静态生成 `6/6` 页面。
- 浏览器使用 `MEMORY=1`、`READYWORK_DEMO_AUTH=1` 和独立会话密钥启动隔离本地栈，日志明确为“未注入演示业务数据”；未访问或写入正式 `data/readywork.sqlite`。Task 3 没有执行外部连接器、发布、发送、同步或采购事实变更。

## 73. 2026-09-02 Clean-room Alignment Task 4 Readywork 公开品牌与自有视觉

- 新增本地 `/readywork/readywork-mark.svg`，使用 `#2563eb` 与 `#0f172a` 的自有 Readywork 标记；新增 `ReadyworkProductVisual` 七类 React 视觉：overview、notifications、drafted-emails、po-timeline、risk-dashboard、route-local、route-import。所有视觉只表达页面几何、标签和 `No persisted data` / `Evidence required` 边界，不含演示 PO、供应商、货币、KPI、风险分数或另一产品截图。
- `/product`、Product metadata、Privacy、Terms、Legal shell、Demo 幂等键与采购生产源码已统一为 Readywork。公开页不再加载外部参考 Logo / 截图，Demo 幂等键改为 `readywork-demo:`；公开 FAQ 与法律文案只陈述监督式执行、具名身份门禁、ERP 可选、人工审批、路线证据、连接器回执和预发布法律状态。
- 为彻底消除生产源码泄露，壳与采购页面共享视觉常量也已改为 `READYWORK_*`，Advanced SLA 和 V1 readiness 等用户文案不再出现参考产品名。`rg -n -i 'navisight' apps/console packages/supply-chain/src --glob '!*.test.ts' --glob '!**/test/**'` 的放行扫描为 `0 production matches`；内部 clean-room 测试描述与本证据文档仍可引用参考名称。
- TDD 红测首次为 `3/7` 通过，精确失败于旧法律外链说明、旧产品文案/远程资产、生产品牌扫描和本地标记不存在。最小实现后品牌/产品/法律边界为 `7/7`；加入真实 Demo API 测试后为 `11/11`。扩大到壳与共享视觉令牌回归时发现一条旧 deep-equal 断言漏记 Task 3 已落地的 `12px` 外边距、`24px` 面板圆角和 `68px` 头高；核对真实消费后只同步冻结断言，最终扩展组为 `17/17`。
- 根 `pnpm typecheck`、Console `pnpm --filter @readywork/app-console lint` 均退出 0；Next.js 16.3.3 production build 编译成功并静态生成 `6/6` 页面。最终产品源、法律源、品牌扫描、Demo API、壳与视觉令牌聚焦回归全部通过。
- Chrome 对 `/product`、`/privacy`、`/terms` 在 1280×720、1440×900、1920×1080 共九组实页逐一验收：全部 `scrollWidth - clientWidth = 0`，本地 Readywork 标记均完成加载，页面标题和正文均为 Readywork，DOM 资源 URL 中参考域和其他远程 HTTP 资源均为 0。`/product` 的 fullName、email、company 三个真实必填项完整存在；没有提交表单。
- 本轮浏览器应用诊断为 `0` error、`0` warning；另有 4 条 `chrome-extension://` 来源的扩展解析错误按来源排除。验收后恢复默认视口并停止本地 Console。Task 4 没有写正式 SQLite、创建 Demo 申请、发送邮件、调用 CRM/Odoo/WhatsApp、发布 SLA 或推进采购事实。

## 74. 2026-09-02 Clean-room Alignment Task 5 Notifications 与 Drafted Emails 真实收件人合同

- `PATCH /api/procurement/message-drafts/:id` 已固定为 `expectedVersion / recipient / subject / body / reason` 五字段白名单。Email 统一 trim + lower-case，拒绝 `example.*`、`demo.cn`、`.invalid`、`.local`、`.test` 和无公网域名地址；WhatsApp 只接受并规范化为 E.164。tenant、channel、PO、supplier、identity 和决策证据不可通过此路由修改。
- recipient、subject 和 body 在同一版本事务中更新。审计 metadata 记录 channel、PO、reason、新旧 recipient 脱敏值与 SHA-256、新旧 subject/body SHA-256；不保存完整收件人或正文副本。测试证明跨租户 404、占位地址/未知字段 422、陈旧版本 409，且最终 Outbox `to` 使用服务端规范化地址。
- Drafted Emails 保留 360px / 380px 队列与 Pending / All，编辑器补齐 To、Subject、Body、Edit reason。reason 未填时 Save 禁用；409/422 不清空用户输入，成功后采用服务端返回的规范化 recipient。Notifications 列表、筛选和 SSE 刷新继续纯读，只有用户点击单条或全部已读才发起写请求。
- 投递状态由持久化 Draft + Outbox 共同决定：`pending → Queued`、`processing → Waiting for connector receipt`、`failed → Failed`、`blocked → Needs attention`；只有 draft=`sent` 且 Outbox=`dispatched` 才显示 `Sent`。Approve & Send 的即时回馈只是 Queued/Needs attention，不冒充最终发送成功。
- TDD 红测首次精确失败于 `hashDraftRecipient` 尚未导出。API 最小实现后单文件 `7/7`；最终 API Notifications + Drafts 与 Console 边界回归为 `14/14`。根 `pnpm typecheck`、Console ESLint 均退出 0；Next.js 16.3.3 production build 编译成功并静态生成 `6/6` 页面。
- Chrome 使用临时 4001 / 4273 / 4274 与去凭据临时 SQLite 验收。空库的 Notifications 与 Drafted Emails 不造通知或草稿；随后仅在隔离 QA 库注入明确标记的草稿状态 fixture，实页确认 Queued、Waiting for connector receipt、Sent、Failed、Needs attention 五态、四字段编辑器和缺 reason 时 Save disabled。未点击保存、批准、丢弃、已读、SLA 运行或外发动作。
- 1280×720、1440×900、1920×1080 三档视口的 Notifications 空态和 Drafted Emails 空态/完整 fixture 页面水平溢出均为 `0px`；应用来源日志 `0` error、`0` warning，Chrome Extractor 扩展自身的 `chrome-extension://` 解析错误按来源排除。视口已恢复，隔离服务已停止，临时 fixture 目录已移入废纸篓，可恢复。
- 正式 `data/readywork.sqlite` 只读复核仍为 Outbox `dispatched=4 / active=0`、message drafts `draft=3`，与本任务前证据一致。本任务没有写正式库、发送邮件、调用 Meta/Odoo、发布 SLA、确认路线或推进任何正式 PO 事实。

## 75. 2026-09-02 Clean-room Alignment Task 6 Local / Import 十列与权威导出

- Migration 49 `navisight-clean-room-alignment-v2` 以加法方式新增供应商 profile/event、PO amendment、文档快照 metadata、路线导出表，并为 Advanced SLA 和 import validation 补齐版本元数据。fresh DB、仅记录 migration 48 的升级库、幂等重跑和双进程共享临时 SQLite 并发均已验证；迁移不生成样例行。
- `POST /api/procurement/routes/:route/exports` 现在是服务端权威 CSV 导出：使用与列表一致的 query/stage/risk/supplierId/RIHD 筛选、稳定水位、RFC 4180 引号、row count 与 SHA-256；同键同请求重放、同键异请求 409、tenant/object 授权与对象存储失败零落库均由集成测试覆盖。Console 不再生成 Blob 或使用 `URL.createObjectURL` 伪写本地 CSV。
- 已登录 Chrome 中的实时参考页作为最高视觉证据。Local 页头为 `Local Procurement / Manage and track all local purchase orders`，Import 为 `Import Procurement / Manage and track all import purchase orders`；工具条顺序为 Search、Filters、Risk、Supplier、Date Range、Export。Local 阶段为 All POs、PO Sent、Supplier Commitment、Fulfilment / Production、Dispatch、Delivery、Completed；Import 精确使用 Transit Tracking 与 Delivery Completed & GRN。Assistant 首屏的标题、说明、五项能力、四个快捷问题、输入 placeholder 和 disclaimer 已对齐，但会话/附件仍走真实持久化 API。
- 主表可见列精确为 PO Number、Supplier、Material Type、Current Stage、Required In-House Date (RIHD)、Days to RIHD、Risk、Next Action、Total Value；第十列表头视觉留空并保留 `aria-label="Row Actions"`。Material Type 为绿色 pill、Stage 为灰色 pill、逾期日期为红色、未来日期为棕色，页脚使用 `Showing x to y of z entries`。Export 在空集时 disabled，验收没有点击。
- 聚焦验证命令覆盖 Persistence / API / Local-Import / Assistant 六文件，最终 `20/20`、exit 0。根 `pnpm typecheck`、Console ESLint 均 exit 0；Next.js 16.3.3 production build 编译成功并静态生成 `6/6` 页面。
- 收尾全仓串行回归为 `655/655`，`fail=0 / skipped=0 / todo=0`；同步修正了两类陈旧边界断言：Persistence 不再将最大 migration 版本写死为 48，并精确校验 migration 49 名称；Advanced SLA 不再要求已被生产品牌门禁清除的参考品牌文案。修正后定向回归 `12/12`，本轮新鲜 `pnpm typecheck`、Console ESLint 与 Next.js 16.3.3 production build 均 exit 0，生产构建静态生成 `6/6` 页面。
- 隔离栈使用 4001 / 4273 / 4274 与内存业务库。Local 和 Import 在 `1280×720`、`1440×900`、`1920×1080` 均为页面水平溢出 `0px`；十列、英文空态和 disabled Export 成立。应用来源日志为 `0 error / 0 warning`；`chrome-extension://...Extractor` 自身 JSON 解析错误按 URL 排除。
- 正式 `data/readywork.sqlite` 只用 `sqlite3 -readonly` 和文件哈希核对：migration 仍为 `48|procurement-route-chat-attachments`，Local=`0`、Import=`0`，`procurement_route_exports` 表仍不存在，未在正式库运行 migration 49。验收哈希为 `b1904986a2281ba2c3a44a9c96b5d1c670530d04b14c2bb7e5607e911dd1d4ec`；本任务没有写正式库、生成导出行、发送邮件/WhatsApp、调用 Odoo、发布 SLA、审批、同步或推进 PO。

## 76. 2026-09-03 Clean-room Alignment Task 12 RiskModelV2 与不可变快照

- 风险评分已从 max-factor 改为固定 `30/25/20/15/10` 的五组件加权模型；`S=80, D=60, V=50, C=40, A=20` 的公开公式结果为 `57`。完整覆盖才发布总分；覆盖至少 70% 且 Delivery Delay 可用时仅给 Provisional；证据不足显示 Score not published，不把缺失证据当零风险。
- 不可变快照按 `modelVersion` 兼容读取；旧快照保持 `Legacy risk snapshot · read only`，不会被 V2 回填。Dashboard 的 KPI、图表、供应商、产品、趋势、高风险表和 CSV 读取同一持久化快照行；Provisional/Not published 均展示 coverage、缺失组件和 `—` 正式风险金额。
- SLA/Advanced SLA 已同步发布状态边界：评估证据冻结 `riskPublicationState`，显式风险规则只接受 Published；Provisional/Not published 即使 provisional band 命中或策略为 `risk=all` 也不能自动外发，只进入 `candidate_risk_not_published` 人工复核。
- 隔离 Chrome 夹具包含 Published、Provisional、Not published 和 Legacy 四类证据。真实 Google Chrome 在 1280×720、1440×900、1920×1080 验证五 KPI、两排三栏和高风险表均无横向溢出；筛选、Escape、外部点击、清除、日期、Legacy、PO 下钻返回、幂等刷新/重载和焦点返回均通过。应用 error/warn 与可见 alert 为 0，十项导航完整。
- 权威风险 CSV 返回 200，并包含 `Risk Model Version / Evidence Coverage / Score State / Missing Components`。最终全库源测试 `713/713`、DOM 交互 `2/2`、TypeScript、Console ESLint 与 Next.js 16.3.3 production build 全部通过。
- 正式 `data/readywork.sqlite` 全程只读且未变：SHA-256 `b1904986a2281ba2c3a44a9c96b5d1c670530d04b14c2bb7e5607e911dd1d4ec`，最大 migration `48`，正式风险快照 `2` 条；未发送邮件、调用 Odoo、发布 SLA 或推进正式 PO。

## 77. 2026-09-03 Clean-room Alignment Task 13 Supplier Operating Profile 与完整 Actions

- 源代码已完成 Supplier master + Operating Profile 同事务创建/回滚、独立主数据/Profile 乐观版本、Odoo 权威字段保护、严格 profile 校验，以及版本化 Deactivate/Reactivate。详情页采购订单只按不可变 `supplierId` 关联，不按供应商名称猜测。
- Suppliers 主表精确为 Code、Supplier、Country、Route、Type、Material、Lead Time、Criticality、Status、Actions 十列；More 菜单精确为 View details、Edit supplier、Manage lead times、View purchase orders、Deactivate/Reactivate。菜单支持 Home/End/ArrowUp/ArrowDown/Escape，关闭后焦点返回 More，弹窗关闭后也恢复触发点。
- 隔离真实 HTTP 流程使用 `/tmp/readywork-task12-final-zgdMFJ/isolated.sqlite`：`supplier:manual:a1ec5793-d9ab-4830-afdd-5846cd414c36` 创建 201、编辑 200、停用 200、启用 200，后续详情与列表均 200；手工 master 与 Profile 都按编辑、停用、启用从 `1 -> 2 -> 3 -> 4`，最终为 `active / unclassified / 28 days / medium`。只读 SQLite 核对 master/profile version 4 和四条顺序事件成立。
- 新鲜验证为全仓源测试 `718/718`、渲染 DOM 交互 `3/3`、根 TypeScript、Console ESLint 与 Next.js 16.3.3 production build 全部退出 0。曾在全仓并发压力下取消的 PO 文档跨子进程测试，单文件 `10/10` 和全仓单并发均通过，未修改其 60 秒阈值。
- 正式 `data/readywork.sqlite` 未变：SHA-256 `b1904986a2281ba2c3a44a9c96b5d1c670530d04b14c2bb7e5607e911dd1d4ec`，最大 migration `48`；没有正式供应商写入、Odoo 调用或邮件/WhatsApp 外发。
- 真实 Google Chrome 验收仍是唯一未闭合项：Chrome 152 正在运行，扩展已安装并启用，Native Host manifest 正确；按规范打开新窗口并单次重连后，Chrome 仍未向控制通道暴露实例。因此没有用应用内浏览器、独立 Playwright 或 AppleScript 替代，也没有声称参考页/本地页的真实点击、外部点击、键盘、焦点、刷新、三视口与 Console 日志已经百分百签字。完成本项需要从 Codex 插件界面重新安装 Browser/Chrome 插件后继续同一任务。

## 78. 2026-09-03 Clean-room Alignment Task 15 Advanced SLA 九域源码与交互

- 本次交付是可运行源代码，不是规格集合。Core 的 schema-v2 合同、Business API 的严格读写/导入合同，以及 Console 的九域编辑器已经同步完成；生产路径不使用 mock、localStorage 或前端假成功，保存、刷新与 CSV 应用均重新读取权威 API 状态。
- 九个领域的字段、分组、控件类型、选项、placeholder、必填和条件显隐按已登录参考页逐项核对。Payment Term 选择 `Letter of Credit (LC)` 后完整展开 LC Details；Common 完整包含 Rule ID、Company Code、Business Unit、Effective From/To、Priority、Status、Created By、Approved By、Last Updated、Notes。Rule ID 可编辑，新规则只在草稿内部使用 `local-${uuid}` 临时身份。
- Template 为直接下载按钮，不存在二级菜单。More actions 精确为 View details、Edit rule、Deactivate、分隔线、Delete；详情底部动作、删除确认、Cancel、Escape、键盘焦点和关闭后焦点回归均有源码实现与 DOM 交互覆盖。详情、停用与删除按规则真实 domain 定位，切换 section 后不会误操作同名或旧 activeDomain 规则。
- CSV 列由同一字段描述器生成并消除了 Communication 的重复 `stage`；未知字段继续 strict reject，旧 v2 参数保持兼容读取。真实 Chrome 文件选择器上传 `apps/console/test/fixtures/advanced-sla-quality.csv` 后返回 `1 total / 1 valid / 0 invalid`，Import 并刷新后出现 `QUALITY-E2E-001`。
- 登录态 Chrome 完成真实新增/保存/刷新/详情/停用/保存/刷新/删除取消/删除确认/保存/刷新闭环；`PAY-LC-E2E-001` 在详情中显示 `LC Type = Sight`，停用后刷新仍为 Inactive，最终删除并刷新后消失。Template 点击后没有菜单或第二个下载按钮。应用来源 console error / warning 为 `0 / 0`。
- 新鲜验证：Core/API/editor-state `26/26`，渲染 DOM 交互 `1/1`，全仓 `725/725` 且 `fail=0 / skipped=0 / todo=0`；根 TypeScript、目标 Console ESLint 与 Next.js 16.3.3 production build全部通过，静态页面 `6/6`。
- 所有写验收只在 `MEMORY=1` 隔离 Business/Control API 中进行。正式 `data/readywork.sqlite` 仍为 SHA-256 `b1904986a2281ba2c3a44a9c96b5d1c670530d04b14c2bb7e5607e911dd1d4ec`，最大 migration `48 | procurement-route-chat-attachments`；未发布 SLA，未发送 Email/WhatsApp，未调用 Odoo。
- 当前窗口对照证据为 `artifacts/advanced-sla/navisight-reference.png` 与 `artifacts/advanced-sla/readywork-aligned.png`。外部 Chrome 的 viewport override 没有改变实际窗口尺寸，所以 `desktop.png`、`tablet.png`、`mobile.png` 不作为三个独立视口的验收证据，也不据此宣称三视口完成。

## 79. 2026-09-03 Clean-room Alignment Task 16 Configuration 源码、门禁与点击边界

- Configuration 已改为完整可运行源码数据链：Console 直接读取 Business API 的脱敏连接摘要，不再将凭据列表传入配置页。API 顶层仅有 `autoSend / connections / permissions`，连接项仅有九个证据字段，不包含 credential ID、名称、schema、密文或 action。
- 页面顺序为 General Settings → Agent Setup → Business Systems → Auto-send follow-ups → Advanced Governance。Agent Setup 固定 Email、WhatsApp、WeChat 三卡；ERP/Odoo 只出现在独立 Business Systems。每卡展示 Runtime、Credential、External Verification、Last Tested、Health 和真实下一步。
- WhatsApp 明确是 `Meta WhatsApp Cloud API`，没有伪造 QR、pairing 或 Linked Devices。WeChat 固定诚实显示 `Not available / Not configured`，无论管理员还是经理都不可点击。已登录参考页的手机配对界面仅用于核对层级，没有被复制成与当前正式 connector 相冲突的假能力。
- Auto-send 展示 `permission / published_profile / communication_identity / allowlists / supplier_target / connector / kill_switch` 七道服务端门禁。任一阻断时 switch disabled；全部就绪时点击只进入服务端 Advanced SLA 策略，不产生本地假 mutation。页面明确说明通过后的消息可绕过 Drafted Emails 人工队列。
- 采购经理只看脱敏状态和禁用管理按钮；管理员的 Email/WhatsApp/ERP 操作才会展开真实 connector control plane。Advanced Governance 默认折叠，支持点击、Escape 收起和焦点返回。凭据保存、测试、断开或 connector 生命周期操作成功后会重新读取配置摘要，刷新页面也保持同一服务端事实。
- 验证为聚焦源码/API `35/35` + Configuration DOM `1/1`，全仓源码 `728/728` + DOM `6/6`，TypeScript、目标 ESLint 和 Next.js 16.3.3 生产构建全部通过。已登录 Chrome 完成参考/本地页面层级、WeChat disabled、Email 深链和 Escape 验收，证据在 `artifacts/configuration/navisight-reference.png` 与 `artifacts/configuration/readywork-aligned.png`。当前外部 Chrome 没有 viewport 能力，三角色×三视口矩阵不冒充已完成。
- 正式 SQLite 全程只读且未变：SHA-256 `b1904986a2281ba2c3a44a9c96b5d1c670530d04b14c2bb7e5607e911dd1d4ec`，最大 migration `48|procurement-route-chat-attachments`，preferences `0`、credentials `2`、connector events `19`。没有发布 SLA、发送 Email/WhatsApp、调用 Odoo，也没有在正式连接上测试或断开。

## 80. 2026-09-03 Clean-room Alignment Task 17 可运行组件与真实交互

- 本次交付是生产源代码，不是书面组件目录。`apps/console/components/ui/` 已提供 Dialog、DropdownMenu、Popover、Tooltip、TanStack DataTable、DateRange、CommandMenu 与 SafeHtml；Risk Dashboard、Suppliers 和全局页头已真实迁入这些组件，API、权限与持久化仍由既有业务层负责。
- 日期范围使用 Popover + 双月范围选择并保留内部 draft；Escape 关闭后焦点返回日期按钮。高风险表使用 TanStack Table 的语义表格、空态与 `aria-rowcount`。供应商 More 菜单固定五项顺序并支持 Home/End/方向键/Escape，打开后首项获得焦点；Radix Dialog 维持焦点陷阱和关闭后返回。
- 全局搜索使用 cmdk；空输入 `aria-expanded=false`，输入两个字符后为 true 并出现 listbox，Escape 后恢复 false 且保留输入焦点。风险 KPI Tooltip 在真实 Tab 焦点时显示，Escape 关闭但保留焦点，Shift+Tab 失焦后关闭。
- 精确依赖版本和许可证已登记在 `docs/THIRD-PARTY-LICENSES.md`。Production bundle 为 12 个 JS chunks；Recharts 只进入一个异步 chunk，cmdk 与 react-day-picker 进入应用 chunk，没有重复图表库。当前没有获授权的业务 HTML，因此 SafeHtml 不被假接入，DOMPurify 也没有进入 production chunk。
- 新鲜回归：聚焦交互 `2/2`，全仓源码 `732/732`，渲染交互 `7/7`，TypeScript、Console ESLint、Next.js 16.3.3 production build 全部通过。所有写入型浏览器证据只使用 `MEMORY=1` 隔离 API；没有触碰正式 SQLite 或外部连接器。

## 81. 2026-09-03 Clean-room Alignment Task 18 最终验收

- 生产品牌扫描为 0；占位扫描命中仅是 Odoo 标识中的大小写子串，没有 Task 18 范围内的 TODO、mock-data 或 fake-success 生产路径。
- `pnpm-workspace.yaml` 固定传递依赖 `fast-uri=3.1.6` 与 `@xmldom/xmldom=0.8.15`，已消除 4 个 high 和 xmldom moderate。审计只余 ExcelJS 4.4.0 的 `uuid 8.3.2` moderate；已安装 ExcelJS 代码只使用无 caller buffer 的 `uuid.v4()`，而 GHSA-w5hq-g745-h8pq 针对 v3/v5/v6 caller-provided buffer，因此不做跨主版本强制 override，等待上游兼容升级并保留输入大小、MIME/魔数、ClamAV 与解析超时门禁。
- 依赖升级后的新鲜验证为源码 `732/732`、渲染交互 `7/7`、文档解析 `6/6`、Temporal Worker `27/27`，TypeScript、Console ESLint 与 production build 均退出 0。一次并行 build 压力下的控制 API 启动探针超时，在发布口径的独立串行全量运行中通过，未放宽测试阈值。
- Chrome 已完成十项业务页三视口 30 次点击和 Product/Privacy/Terms 三视口 9 次加载；1280×720、1440×900、1920×1080 均无水平溢出、可见业务 alert 或应用 error/warn，viewport 已恢复默认。
- QA 前后正式数据库只读证据一致：size `24854528`、mtime `2026-09-02T00:43:27+0800`、SHA-256 `b1904986a2281ba2c3a44a9c96b5d1c670530d04b14c2bb7e5607e911dd1d4ec`、integrity `ok`、migration `48|procurement-route-chat-attachments`。
- 登录态 Chrome 已完成批准的桌面 Web 范围。十项业务导航在 1280×720、1440×900、1920×1080 共完成 30 次点击；Product、Privacy、Terms 在三个视口共完成 9 次加载；PO 六个详情页签与五个 Actions 由所属任务的 Chrome checkpoint 覆盖。
- 隔离浏览器状态矩阵已完成：normal、empty、loading、read error、403、404、409、422、connector-not-ready、external pending、unknown、kill switch 均有直接 UI 证据。供应商 409/422 后对话框和输入均保留；Odoo 取消从 `Pending external` 切换到 `Needs attention` 时保持同一 Idempotency-Key、Request ID 与 Outbox ID；连接器与 kill-switch 阻断时 auto-send 开关保持 disabled。
- 最终串行回归为源码 `732/732`、真实 React 渲染交互 `7/7`，TypeScript、Console ESLint 与 Next.js 16.3.3 production build 全部通过。正式依赖审计只保留 ExcelJS 4.4.0 → uuid 8.3.2 的一个 moderate；ExcelJS 仅无 caller buffer 调用 `uuidv4()`，不存在公告针对的 v3/v5/v6 caller-provided buffer 路径，等待上游兼容升级。
- 隔离 Business API、Control API 与 production Console 已停止，4173、4174、3002 均无监听；状态注入 Chrome 标签已关闭，Fetch interception 已清空。
- 最终正式 SQLite 只读校验前后完全一致：integrity `ok`、size `24854528`、mtime `2026-09-02T00:43:27+0800`、SHA-256 `b1904986a2281ba2c3a44a9c96b5d1c670530d04b14c2bb7e5607e911dd1d4ec`、migration `48|procurement-route-chat-attachments`。

### 批准规格逐项验收表

| Requirement | Evidence | Status | Remaining external gate |
|---|---|---|---|
| 精确依赖与第三方许可证 | `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`docs/THIRD-PARTY-LICENSES.md`，production audit 与 bundle 检查 | 工程完成 | ExcelJS→uuid 的不可达 moderate 等待上游替换 |
| Readywork 品牌与固定十项采购 IA | `packages/supply-chain/src/procurement-employee-pack.ts`、Console shell、生产品牌扫描 0 命中、Chrome 30 次导航点击 | 完成 | 无 |
| 桌面壳、URL/history、点击、键盘、焦点与刷新 | `apps/console/app/page.tsx`、导航/状态模型测试、三个批准视口的登录态 Chrome | 完成 | 手机与原生端不在批准 V1 范围 |
| Clean-room Product、Privacy、Terms 与登录边界 | `apps/console/app/product`、`privacy`、`terms`；三个视口 9 次加载；无参考品牌/资产进入生产源码 | 完成 | 运营主体和最终公开联系方式需商业批准 |
| Notifications 与可编辑 Drafted Emails | `notifications.tsx`、消息草稿 API/交互测试；Chrome loading、timeout、403 状态 | 完成 | 正式发送仍需批准身份、收件人与已验证连接器 |
| Local / Import 表格与权威路线导出 | 路线 workbench、repository/API/export 测试与 route-chat 证据 | 完成 | 正式库 route assignment 为 0，需业务证据 |
| PO 六页签只读合同 | `po-employee.tsx`、PO view-model/API 测试与所属 Chrome checkpoint | 完成 | 正式五阶段/GRN 证据尚未形成 |
| v2 共享合同、仓储与隔离 migration-49 | Core/persistence/API 的 profile、amendment、document、cancellation 测试 | 完成 | 正式库按要求停在 migration 48，待批准部署 |
| 来源感知 Edit PO 与乐观锁 | procurement execution API、Outbox/Odoo Worker 测试、Edit 渲染交互、409 表单保留证据 | 完成 | 正式 Odoo 写需连接器与变更批准 |
| 确定性 PDF / Print 快照 | PO document API/object-store 测试、多页八列表头、PDF/HTML 共用快照哈希 | 完成 | 正式对象存储与字体部署需环境 readiness |
| 加法式 Cancel PO 与回执读回 | Cancel API/Temporal/Outbox 测试；Chrome danger dialog、`Pending external`、同键 `Needs attention` | 完成 | 真实取消需双权限与 Odoo 权威读回 |
| RiskModelV2 与不可变快照 | 固定公式 Core 测试、API/snapshot 测试、Dashboard/CSV/Chrome 证据 | 完成 | 正式快照数为 2；新快照需显式生产运行 |
| Supplier Operating Profile 与完整动作 | Supplier API/persistence 测试、十列表、五项菜单、渲染交互、Chrome 409/422 | 完成 | 正式 migration-49 profile 为 0，待部署 |
| 简化 base SLA 目录且保留治理 | SLA Core/API/automation/渲染交互与所属 Chrome 证据 | 完成 | 正式 SLA 为 1 draft / 0 published，发布需批准 |
| 九域 Advanced SLA v2 与 typed CSV | Core/API/editor-state 测试、九域 Chrome loop、CSV preview/apply/reload | 完成 | 正式 Advanced SLA profile 为 0，未发布策略 |
| Configuration 层级、脱敏、角色边界与 auto-send 真值 | Configuration API/UI 测试；Chrome connector-not-ready、deep-link、disabled switch、kill-switch blocker | 完成 | 具名身份、目标/连接器验证和运行策略仍必须满足 |
| 可访问生产组件 wrappers | Dialog、DropdownMenu、Popover、Tooltip、DataTable、DateRange、CommandMenu 源码；`7/7` 渲染交互；单异步 Recharts chunk | 完成 | SafeHtml 在有授权 rich-HTML producer 前保持未消费 |
| 全页面/状态/视口验收 | Chrome 覆盖 12 类状态、全部批准视口、十项导航、法律页与 PO 交互 | 完成 | 工程验收无剩余项 |
| 正式数据保护与不伪造外部成功 | QA 前后 SQLite hash/size/mtime/count 完全相同，integrity `ok`；浏览器仅 `MEMORY=1`；未正式调用 Email/WhatsApp/Odoo | 完成 | 正式 rollout blocker 必须由授权业务动作解决 |

### 最终验收边界

批准的源代码、点击、键盘、焦点、刷新、API 与隔离持久化对齐已经完成。该结论不等于正式租户可以自动发送或自主运行。正式库当前仍为 32 张 PO / 26 张活跃 PO、0 条路线分配、34 条阶段事件 / 0 条 completed、1 个 SLA draft / 0 个 published、0 个 Advanced SLA profile、12 家供应商、2 个风险快照、49,697 条安全事件 / 49,654 条未处置、4 条 dispatched Outbox / 0 条 active、0 个 communication identity。这些是显式 production rollout gates，不是缺失 UI，也不能用 mock 代替。

### 2026-09-08 消息网关正式运行栈切换（Task 7）

本节是本次切换后的观测值，前述日期更早的生产数据是历史验收快照。2026-09-08 15:01（Asia/Shanghai）精确重启 Console、Business API、Control API、Temporal Worker，Docker Temporal 集群保持运行。项目使用固定 Node 24 PATH；Business/Control 连接真实 `data/readywork.sqlite`，正式迁移从 52 升至 53。Worker 保留已验证 DSH checkout 与 DeepSeek 环境，在 DSH initialize 预检之后连接 Temporal；未使用 MEMORY=1 或 inmemory。

- 正式数据库的只读基线与切换后快照逐条比较：11 条历史 email Outbox 的全记录、status与attempts前后完全一致，均为dispatched、attempts=1。其中7条原有provider Message-ID，哈希前后不变；另4条原本无Message-ID，快照保留缺失标记与空串哈希，缺失值不作为SMTP成功回执。具体为4条draft_email.send均有ID、5条purchase_order.send中3有2无、2条rfq.send均无；11条全部为email，缺失值不能解释为其他通道。Communication仍为9；P00021文档、路线和阶段记录均不变。本次正常Outbox/网关路径未重新派发历史命令，也没有伪造迁移前不存在的messaging delivery。
- 登录后 `/api/messaging/gateway` 返回 200，Email 为 running v1；pendingInbound=0、pendingDeliveries=0、exceptionalDeliveries=0。Business/Control `/health` 均为 200，Temporal 初次观察2个 Poller、全量测试后复读1个且workerReady=true；Outbox pending/processing/failed/blocked/expired leases 均为 0。
- P00021 已有 2026-09-08 02:44 发送的同目的确认跟进草稿，Outbox ID 尾段 `f8640a6527df`。其后真实供应商回复为 0，本轮禁止重复发信。15:04 的一次人工 IMAP 检查 HTTP 200、completed、handledCount=20；这些入站先持久化，再全部以 `NO_PO_OR_ATTACHMENT` 拒绝，未新建 Communication。示例脱敏入站 ID：`messaging-inbound:19b1090e…457fcc`。网关 accepted delivery 仍为 0，不能据此宣称新网关 SMTP→真实回复→DeepSeek→采购命令纵切已完成。
- P00021 仍为 confirmed v3、路线 unclassified；没有正式 Confirmation、Production Progress、Shipment 或 Receipt。只读查询真实 Odoo 返回 `WH/IN/00021`（id=21）为 assigned、无完成时间，未发生 Odoo/WMS 写入。
- `/api/operations/v1-readiness` 仍为 blocked，9/11；阻断项为真实本地 PO 与真实五阶段闭环。消息网关上线不增加或替代原 11 项门槛，也不能替代真实路线和 Odoo/WMS GRN。
- 测试证据：新增文件 SQLite 重启/租约/熔断集成测试 3/3，连同真实 control HTTP readiness 为 7/7；原实现直接通过，随后仅测试进程的 accepted 状态丢失变异产生预期 RED（unknown≠accepted），解除变异后 GREEN。全量首次运行真实暴露两个 migration 52 旧断言，修正为 53 后 persistence 测试 9/9；完整 `pnpm test` 最终 **1048/1048**（823+1+224）、0 fail/cancelled/skipped，exit 0。根 typecheck 与 Console build 均 exit 0；正式 SQLite quick_check=ok。Chrome 验收详见本任务报告。

- 主任务已通过原生Chrome核验Configuration刷新前后：Email网关均为“运行中”，提供方“标准邮件传输服务”、版本1，待处理入站/待投递/异常投递均0；凭据“已验证”单独显示在连接卡中。P00021 communication页仍显示未分类采购、Readywork发出0/已接收2/待审0、两条8月19日历史回复，以及两条attempts=1的历史Outbox，无第三条。最终warn/error日志与P00021 overview完整渲染仍未取得，不能签浏览器全验收完成。

完整运行证据与测试日志位于 `.superpowers/sdd/2026-09-08-hermes-inspired-messaging-gateway-boundaries/task-7-report.md`。Fix round 1审查确认初版登录探针含凭据字面量，已移除并改为必需的运行时环境变量，无默认值、缺失即失败且不发请求，文件权限0600；不复述原值。报告中的“工件不含凭据值”保证以本次修复后静态核验为准，不能追溯声称初版已满足。
