# 当前版本前端对齐复验

目标：前端源码、点击、交互全部 100% 对齐。状态：工程对齐验收完成，正式总账 **41/41（100%）**。

依据：用户已批准的 2026-09-02 clean-room 规格，以及当前已登录的 Navisight 实页。后续“全部中文”要求优先于旧规格的英文标签。保留 Readywork 品牌、真实数据、审批、权限、版本、幂等与外部回执门禁；不把参考演示数字复制成业务事实。旧文档的完成记录不代替当前版本验证。

验证范围：十个一级页面、PO 六页签与五项 Actions；所有可见按钮/菜单/弹窗/筛选/排序/分页/导航/键盘/刷新；正常、空、加载、错误、权限、冲突和外部状态；1280×720、1440×900、1920×1080 桌面。整体完成必须有逐项实证，不用部分测试外推。

环境：非 Git 目录，原地保留已有文件；3001 Console、4173 Business API、4174 Control API。参考平台只读/打开界面，不保存、删除或提交业务操作；写验收使用隔离数据库。数据导入是此前另一项已授权工作，不能代替对齐验收。

## 进度与证据

| 项目 | 当前证据 | 状态 |
|---|---|---|
| 参考读取 | 十主页面契约与 PO 六页签均已采集：`artifacts/alignment-20260906/reference-page-contracts.json`、`reference-po-contract.json`。参考七张抽样 PO 的 Edit/Duplicate/Cancel 均禁用，未绕过门禁。Items 参考空页实点 Filter/Group by 无状态变化；参考公开运行包进一步确认非空每页5行、搜索字段、明确延期三段筛选和分类/状态汇总 | Items 参考行为已取得直接证据；禁用动作弹窗仍受门禁 |
| PO 独立页供应商差异审批 | 已补卡片、原单/待审对比、短交风险、批准/拒绝、结果提示；5 项 DOM 回归通过，最终矩阵已纳入审批可达性、权限、焦点和结果状态 | 已关闭并纳入整体回归 |
| 中文全覆盖 | 总览、PO主要区域、通知、邮件草稿、本地/进口采购与助手、供应商/制造交期、风险看板、基础/高级 SLA、登录、开发者控制面、配置偏好、公开产品与法律页的系统 UI 已直接源码中文化；稳定 API 枚举不变，业务原文有真实 observer 回归。供应商目录未知路线/类型的原文保护已由 `Pending`/`Supplier` 碰撞回归验证 | 系统 UI 中文与业务原文保护矩阵已关闭 |
| PO 全动作/六页签 | Overview、Items、Supplier、Documents、History、Communication 六页签完成 **144/144**；Edit、Mark as、Duplicate、Print、Cancel 五项 Actions 完成 **108/108**。最终为 84 场景 × 3 视口 = **252/252**，覆盖真实 handler、隔离 SQLite、点击、键盘、焦点、刷新、权限、冲突、错误与外部状态 | 六页签和五项 Actions 全部关闭 |
| 总览 | 系统文案已直接源码中文化，业务原文保留；稳定首加载壳、真实数据、真实空态、401/403/503 与筛选/日期/分页/PO 导航在三视口共 21/21 通过；宽表仅内部横滚 | 本页适用状态、点击、键盘、焦点与密度矩阵已关闭 |
| 通知 | 系统标题、筛选、相对时间、空态与 ARIA 已源码中文化；管理员/审计员权限、空态、401/403/409/503、单条已读、全部已读、权限撤销与导航在三视口共 36/36 通过 | 本页适用状态、权限、写入保留、点击、键盘与焦点矩阵已关闭 |
| 邮件草稿 | 系统 UI 已源码中文化；管理员/专员/审计员三权分离、全部持久化派发状态、空态、SLA/身份缺失、401/403/404/409/422、权限撤销、连接器阻断/入队与丢弃在三视口共 51/51 通过；queued 不冒称 sent | 本页适用状态、权限、版本/幂等、连接器边界、点击、键盘与焦点矩阵已关闭 |
| 本地/进口采购 | 10列、阶段、筛选/权威导出、助手、行操作、路线证据与持久化已在真实 handler+隔离 SQLite 中覆盖；137 场景×3视口=411/411 检查，477 张权威截图 | 本页全部适用状态、权限、点击、键盘、焦点、冲突与外部状态矩阵已关闭 |
| 风险看板 | 产品影响已改3列语义表，现有供应商/PO表保留；系统UI和日历ARIA源码中文。真实 handlers + 隔离 SQLite 已覆盖加载、操作员/审计员空态、V2 三种发布状态、无匹配筛选、缓存失败、401/403/422、三种陈旧原因、legacy 与权限中途撤销，14 类状态 × 3 视口 = 42/42；H1 为 26px/700，七个分析标题为 15px/600，页头控件 36px，页面横溢出 0 | 本轮完整适用状态与参考密度已关闭；不外推到其他页面 |
| 供应商 | 8列目录、详情/关联PO、创建/编辑/停用/重启、制造交期、只读权限、必需/可选数据源、409/422、单飞、Home/End/Escape 与回焦已用真实 handler+隔离 SQLite 完成 21 场景×3视口=63/63 | 本页全部适用状态、点击、键盘、焦点、权限与持久化矩阵已关闭 |
| SLA / Advanced SLA | 基础 SLA 覆盖加载/空/读失败、草稿/发布/退役、自动化独立失败、角色权限、404/409/422/503、发布/退役确认、单飞与焦点，22 场景×3视口=66/66；Advanced SLA 九域、CSV 与生命周期矩阵也已关闭 | 基础与高级 SLA 当前适用的源码、交互、权限和持久化矩阵已关闭 |
| 配置 | 偏好设置、最新读取胜出、缓存刷新失败、管理员/经理/买方权限、Email/WhatsApp/WeChat/ERP 真实状态、七道自动发送门禁、kill switch、401/403/409/422/503 与持久化已覆盖，29 场景×3视口=87/87 | 本页全部适用状态、角色、点击、焦点、连接器边界与偏好持久化矩阵已关闭 |
| 品牌/法律/登录/全局壳/开发者面 | `/product`、`/privacy`、`/terms` 及产品截图组件已直接中文源码化；登录页覆盖本地密码、企业身份提供方未接入、服务不可用恢复、密码显隐、同周期防重入和会话过期。十项业务导航与生命周期标签已从权威 Employee Pack 清单直接中文化。开发者编排、运行、规则、测试、版本、日志六页签与画布无障碍文案已中文化；员工编译器已补齐对话框语义、焦点闭环、Escape 和触发按钮回焦 | 上述范围及完整平台适用状态矩阵已验收 |
| 全量测试、构建、三视口及状态矩阵 | 最终冻结源码 `pnpm test` 为 **779 + 1 + 223 = 1003/1003**；React 定向 **14/14**；生产 Console build、root/Console 类型检查和定向 ESLint 均 exit 0。PO 最终矩阵 **252/252**，运行态复验确认 4173 为 Business、4174 为 Control、3001 登录和真实读取正常 | 工程门禁全部通过，正式总账 **41/41（100%）** |

完成记录均链接实际源码、测试或本轮浏览器证据，并明确区分工程对齐与租户业务就绪度。

## 本轮已关闭的代码缺口

- `apps/console/features/procurement/po-employee.tsx`：常规动作放入既有右侧列，保留参考指标首位和固定五项页头菜单；供应商差异/运行审批仍显式呈现。聊天建议只定位并聚焦，不提交业务。
- 同文件：最新活跃请求负责解除加载状态，修复 quiet 刷新取代初始读取后选错深链订单或永久转圈；后台刷新失败保留已知数据并提供重试。
- 同文件：复制/确认采用 Radix 模态层，Tab/Shift+Tab 限定焦点，Escape/关闭恢复触发点；提交中禁止关闭和重复提交；复制成功切换新 PO 的焦点路径有回归。
- 同文件：只读深链不能打开写表单；缺失 task 的待审批上下文不回落到普通执行；打开弹窗后撤销权限也不能提交。Edit/Mark/Duplicate/Cancel 使用最新权限，通用确认重新匹配当前可执行动作。
- `apps/api/src/procurement-workbench.ts`：生成文档保持逻辑 document id，新增 snapshotId 与认证 PDF 地址；文档生成后 Console 立即刷新详情。真实测试创建→工作台→读回不可变 PDF 字节，并覆盖 401/403/跨租户 404。
- `po-employee.tsx`：Failed / Blocked 筛选包含真实 blocked 事件。
- `packages/persistence/test/procurement-clean-room-v2-migration.test.ts`：移除过时迁移数量断言，仍校验迁移记录、既有记录不覆盖与二次运行 no-op；未改迁移生产代码或真实数据库。

## 新增行为测试

- `apps/console/test/po-employee-action-reachability-interaction.test.tsx`
- `apps/console/test/po-employee-realtime-interaction.test.tsx`
- `apps/console/test/po-employee-modal-focus-interaction.test.tsx`
- `apps/console/test/po-employee-documents-history-interaction.test.tsx`
- `apps/console/test/chinese-ui-contract.test.tsx`
- `apps/api/test/procurement-po-documents.test.ts`（新增工作台 reopen 真实纵切测试）

所有新增 TSX 测试已注册到根 `pnpm test`，不只在临时命令中运行。现有审批/页面测试保留业务断言，清理时等待 Radix 的延迟焦点任务，避免测试 DOM 已卸载后的异步污染。

前一轮验证进程（历史）：`pnpm test` session 1617，exit 0，基础 759/759、取消流程 1/1、DOM 74/74；build session 66902，exit 0。对应 `verification-results.json`，不得用它覆盖后续源码。

## 浏览器证据与边界

十主页面契约与 30 张三视口截图：`artifacts/alignment-20260906/local-page-contracts.json`、`artifacts/alignment-20260906/local-screenshots/`。当前页面标题 x=276 与参考一致，不等于所有控件坐标已一致。

PO 最新只读实页：`/tmp/readywork-po-actions-{1280,1440,1920}.png`、`/tmp/readywork-po-confirmation-{1280,1440,1920}.png`。三个视口均确认指标首位、操作位于 aside、无全局横溢出、确认框初始焦点在内、Escape 回到触发按钮，浏览器异常 0、写请求 0。订单和邮件未因验证而被审批、发送或改变。

## 后续源码轮：PO 六页签、表单纵切与中文弹窗

- `po-employee.tsx`：四类弹窗的标题、字段、枚举显示、无障碍标签、提交中/冲突/已保存/等待外部回执/结果未知/明确失败提示直接中文；HTTP 参数、版本、权限与幂等键不变。
- 供应商档案 route、supplierType、productCriticality 不再直接显示系统码。已知值中文、未知值和行业/物料/付款条款业务原文保持不变。
- 必需文档警告只包含 `required === true && state === "missing"`，可选缺失文件不误报；风险/下一步/历史/消息的业务原文不被全局 observer 改写。
- 复制成功反馈绑定新订单 ID：权威工作台已读回新订单后才显示成功，随后详情加载不再清掉提示；切换其他订单即清除，避免跨订单误投射。
- 五种人工事实表单：确认、生产、发运、运输、收货，30 项交互覆盖完整载荷、校验、409/422 输入保留、提交中防重入和实时权限撤销。
- `po-employee-evidence-forms-persistence-integration.test.tsx` 使用真实 API handlers、签名测试会话和迁移后的临时 SQLite；提交后核对数据库和权威 GET，再全新 React/JSDOM 挂载。5 个子流程加父测试共 6 项，最终 Outbox 为 0。它不是 Chrome 写业务测试，且没有触及生产数据库或连接器。
- 新增中文与参考状态测试均不依赖 DOM 翻译器生成系统中文；业务保护另有挂载真实 observer 的回归。

最终验证：`pnpm test` session 52695，exit 0，758 + 1 + 132 = **891**；`pnpm --dir apps/console build` session 49644，exit 0，编译、TypeScript 和 6 个静态页面生成通过；root 类型检查 session 91609 exit 0；本轮完整针对性 lint session 50394 及最终变更 lint session 12764 exit 0。独立只读复核关闭全部本轮 findings，但不代表全平台完成。

当前校验记录与源码 SHA-256：`artifacts/alignment-20260906/verification-source-round-results.json`。实页结构记录：`live-po-source-round-results.json`；截图 `/tmp/readywork-reference-round-{overview,items,supplier,documents,history,communication}-{1280,1440,1920}.png` 与 `/tmp/readywork-dialog-chinese-{编辑采购订单,复制订单,取消采购订单}-{1280,1440,1920}.png`。主代理实看了编辑、取消、History 截图。

浏览器 session 55684 exit 0：18 个页签页次、9 次真实弹窗打开，全部 560px 宽且未超出视口，初始焦点在弹窗内，Escape 返回 Actions，浏览器异常和业务写请求均为 0。捕获覆盖不变的只读布局面；最后的复制成功反馈修复由最终交互回归覆盖。之前 session 23610 在 Items 可见性等待中超时，未采到故障现场，重跑未复现；保留为待留意的不稳定性，不宣称已定位或修复原因。

## 验收口径与业务边界

工程对齐按已批准 clean-room 规格、参考实页可观察行为、真实前后端合同和 SQLite 持久化验收，现已 **41/41（100%）**。参考平台未提供内部源码，因此这里的“源码级对齐”指本平台不是 Mock、假成功或书面规格，而是生产源码实现与可观察页面、点击、键盘、焦点、刷新及状态合同逐项一致；不声称两套私有源码逐字节相同。

当前租户生产就绪度仍为 **6/11 blocked**。未发布 SLA、durable runtime、安全事故、活跃 PO 分类和真实五阶段闭环属于业务/安全事实，不是前端对齐缺陷；本轮没有为追求绿色状态而自动发布 SLA、处置安全事件或篡改正式业务数据。

## 后续源码轮：文档元数据、历史投影、通知与邮件草稿

- `procurement-workbench.ts` 从同租户实际附件表读取版本、创建人、创建和解析时间；文档核验要求 `clean + parsed`。快照使用源PO版本/模板版本、独立 `generated` 状态、不可变 `snapshotId` 与PDF URL，不伪称经过附件扫描。存储没有扫描完成时间，更新时间只取已记录创建/解析时间，UI明确提示。
- `po-employee.tsx` 上一轮按旧契约实现八列；本轮重新读取参考实页后恢复为七列：文档名称、分类、上传人、上传时间、状态、文件大小、操作，并以行点击/键盘打开340px详情列。未知核验仍显示 `—`，不根据旧status猜“已核验”；真实parser枚举包括 `parse_failed/needs_ocr/needs_specialist` 均源码中文化，未知原值保留。文档打开链接经标准URL同源校验，拒绝 `/\\host` 归一化跨域。
- 新 `procurement-po-history.ts` 已接到真实workbench API：每条amendment用自己的state，修复同类变更串用首条状态；稳定type保留，中文typeLabel/label和原summary分开。ID/actor/时间/state原值不截断，未知actor在UI显示 `—`。新旧历史分支均用独立type/source筛选，不用业务meta猜事件类型。
- `notifications.tsx`、`message-drafts.tsx` 直接源码中文化；业务主题/正文/收件人/配置标签及错误原文保留，API路径、版本、幂等和外部回执门禁不变。已移除两处过时英文源码文字断言；中文与载荷/状态行为由实际React测试覆盖。
- RED已观察：文档缺元数据、clean/queued误verified、旧7列表、历史applied误requested、中文摘要/筛选、四项复核边界、反斜杠跨域链接。各项GREEN并纳入最终全量；未添加只在临时命令中的TSX测试。

该轮历史源码验证：`pnpm test` session **64389** exit0，**766 + 1 + 139 = 906**；生产构建 session **99109** exit0（TypeScript与6静态页）；root类型检查 **14632** exit0；变更Console lint **46257** exit0。该结果已被下方二次实页收口的946项当前验证替代。API无有效ESLint配置，不虚报该范围lint。

浏览器 **27134** exit0：通知/邮件草稿使用实页只读，文档/历史使用当前真实HTTP handlers和迁移后临时SQLite，三个视口共 **12** 页次；无全局横溢出，pageerror/失败API读取/业务写请求均0，隔离Outbox为0。截图 `/tmp/readywork-source-data-{notifications,message-drafts,documents,history}-{1280,1440,1920}.png`；主代理实看文档1280、历史1440和草稿1440。最早收集器47184因同名文件同时出现在表格与附件披露区而定位失败，限定tbody后通过，并非应用错误。浏览器检查早于最后同源URL加固；不变的页面结构/合法地址已有覆盖，最后边界由最终DOM回归覆盖。

### Documents / History 二次实页收口

- Documents 未知分类不再被空 fallback 吞掉；`Custom Category` 等业务分类原样显示。七列参考表保持 `Filter / Category` 的无状态按钮行为，鼠标、Enter、Space 可打开详情列。
- History 的 `筛选 / 全部活动` 与参考平台一致为无状态按钮；事件源扩展到阶段、路线、路线证据文档、SLA评估、进口单证和PO行数量，按 tenant、PO、PO行隔离，保留原始ID、actor、时间、状态和证据引用，不虚构审计事件。
- 该轮冻结源码验证：`pnpm test` session **54979** exit0，**771 + 1 + 174 = 946/946**；生产构建 session **66144** exit0；root类型检查 **42043**、Console类型检查 **93718**、本轮定向ESLint **68928** 均exit0。后续当前结果见文末风险看板状态/密度收口记录。
- Chrome 三视口共12个状态，浏览器记录时间 `2026-09-06T06:49:37.596Z`；页面异常0、失败读取0、业务写请求0、隔离Outbox 0。Documents 1280宽表仅内部横滚，History权威10条事件完整显示。
- 当前哈希、12张截图与完整命令证据：`artifacts/alignment-20260906/verification-documents-history-round-results.json`；运行态记录：`live-documents-history-round-results.json`。

**本轮未重启生产Business API、未发送邮件、未审批订单、未发布SLA、未导入生产数据。** 隔离SQLite与真实HTTP handler通过不等于最新后端已部署；本轮23/23收口也不代表全平台100%。

## 后续源码轮：采购路线、供应商、风险看板

- `route-workbench.tsx`、`route-workbench-controls.tsx`、`route-workbench-view-model.ts` 与 `route-chat.tsx`：10列采购表、系统阶段/风险、菜单/筛选/分页/导出/ARIA、助手状态与提示直接源码中文化；API枚举/载荷/版本/幂等保持稳定。快捷问题保持点击立即且仅发送1个请求，不能误改为仅填输入框；挂载和浏览不发送。日历使用DayPicker中文locale，供应商筛选、对话正文/附件和未知风险因素的真实标签保持原文。
- `suppliers-workbench.tsx`、`material-lead-times-panel.tsx`：8列供应商目录、添加/编辑/详情/关联PO/停用及制造交期系统UI直接中文。实际React回归覆盖完整创建/编辑载荷、409保留输入、expectedVersion、停用原因和键盘焦点。真实全局翻译器RED复现 `Pending→待处理` 后，在业务值节点加窄保护；联系人/行业/物料/备注/详情标题、未知PO状态及编号保持原文，不对整个页面禁用翻译。
- `risk-dashboard.tsx`、`risk-dashboard-view-model.ts`、`components/ui/date-range.tsx`：产品影响改为产品/延期订单数/风险金额3列语义表，维持冻结快照数值、分币种金额和正确PO-ID导航。系统状态与ARIA中文，筛选弹层Escape回焦，日期值仍是ISO契约。
- 风险读取失败不再伪装成无快照，403保留权限提示和安全requestId；旧数据加载/失败时明确指出上次成功快照，并禁止用新查询导出旧表。缺少或未发布评分不作为零风险，供应商多PO使用一致的冻结均分；暂定均分逐单披露具体证据覆盖率/缺失项，不编造聚合覆盖率。旧模型指标不声称已发布V2。
- 新 `risk-dashboard-interaction.test.tsx` 的10项DOM测试已注册到根全量脚本；包含真实observer对订单编号/自定义风险标签的保护回归。接口持久化检查使用迁移后的临时SQLite，不启动外部worker。供应商测试的RAF调度修正为真实ID→timer映射，未通过丢弃回调伪造通过。
- 独立只读复核关闭本轮日期ARIA、业务原文及未知风险因素等具体发现，快检11/11。后续复查确认 `suppliers-workbench.tsx:233–234` 已对未知路线/类型 fallback 加窄范围原文保护；完整供应商交互文件再次运行 1/1 通过（含真实 observer 下 `Pending`/`Supplier` 不被译写）。

最终验证：`pnpm test` session **43912** exit0，**766 + 1 + 151 = 918**；build **46306** exit0（TypeScript和6静态页）；root类型检查 **39461** exit0；Console类型检查 **63055** exit0；19文件Console lint **63547** exit0。首轮917是增量保护回归前结果，已由918替代；不虚报API lint。

浏览器 **66189** exit0：3视口风险页、1次真实时间推进后的陈旧快照、3视口本地采购/进口采购/供应商，共 **13** 次。风险使用当前真实HTTP handlers+隔离SQLite，唯一显式快照POST不触及生产；PO fixture摘要不变、隔离Outbox0、快照2（含既有legacy种子），生产业务写请求0。实页采购10列、供应商8列；供应商与制造交期加载均结束后再截图。0页面异常、0控制台异常、0失败API读取、无全局横溢出。主代理实看供应商1440和风险1920。

收集器曾有SQL字段错误、缺显式select标签、Escape焦点异步竞态、空Next.js route-announcer误判和供应商加载态截图问题；最终已按实际状态修正定位/等待并完成重验。旧65770截图不再当作供应商已加载证据。截图只证明已捕获结构和已知状态，最后业务原文增量由918项中的真实observer回归覆盖，不等于全状态或像素级一致。

最终命令、复核边界及21文件SHA-256：`artifacts/alignment-20260906/verification-risk-route-supplier-source-round-results.json`。浏览器终端摘要：`live-risk-route-supplier-source-round-results.json`；可复跑收集器：`verify-risk-source-round.ts`。**本轮未重启Business API（PID82043仍在）、未发送邮件、未提交审批、未导入参考数据**。文档/历史后端仍不能把隔离验证说成生产部署。全平台目标保持进行中。

## 后续源码轮：公开产品页、法律页与演示表单

- `app/product/page.tsx`、`app/product/layout.tsx`、`features/marketing/readywork-product-visuals.tsx` 的产品导航、Hero、问题/解决方案、五阶段、风险洞察、客户价值、FAQ、演示区、页脚、元数据和嵌入式产品截图已直接改为中文源码，保留 Readywork、AI、ERP、SLA、CRM、SAP、QuickBooks、Gmail、Outlook、Office 365、WhatsApp、WeChat 等品牌或技术名称。
- `app/product/demo-request-form.tsx` 的标签、占位符、选项、提交中、成功、失败和重新提交已直接中文化。新增同步 `submissionInFlight` 门禁，修复两个同事件周期提交会发出两次 POST 的竞态；失败保留表单和原幂等键，成功后才重置并为下一份申请生成新键。
- 站点根元数据显式使用本地 Readywork SVG 图标，关闭了浏览器默认请求缺失 `/favicon.ico` 导致的 404 和控制台错误。
- 新增 `product-source-chinese-rendering.test.ts` 并将嵌入视觉组件纳入无运行时翻译器的源码测试；与法律页测试共2/2。新增 `demo-request-form-interaction.test.tsx` 2/2，已注册到根 `pnpm test`。Console 类型检查及本轮6文件 lint 通过，0错误、0警告。
- Chrome 收集器 `verify-public-pages-round.ts` 在 1280×720、1440×900、1920×1080 三视口遍历 `/product`、`/privacy`、`/terms` 共9页次：中文页面/标题、FAQ 鼠标与 Enter 键展开、风险区锚点、法律目录锚点、无全局横向溢出均通过。pageerror 0、console error/warning 0、失败响应0、写请求0。主代理实看产品1440、隐私1440和条款1280长图，未见截断、错位或英文系统文案。

证据、9张截图 SHA-256 与13个源文件 SHA-256：`artifacts/alignment-20260906/verification-public-pages-round-results.json`。**浏览器验收未提交演示表单，未发送邮件、未写 ERP、未联系供应商、未审批订单、未发布 SLA、未操作连接器或生产业务数据**。此轮关闭公开产品/法律范围，不代表已登录平台整体验收完成。

## 后续源码轮：登录、会话与全局采购外壳

- `auth-gate.tsx` 的登录服务检查、本地密码、企业身份提供方未接入、服务不可用、密码显隐、登录失败和会话过期均为直接中文源码；同步 `loginInFlight` 门禁防止同一事件周期重复登录 POST。源码测试原先以大小写不敏感规则把内部字段 `"username"` 误报为可见 `Username`，本轮最小修正为只匹配精确可见大小写，未放宽对真实英文文案的禁止范围。
- `PROCUREMENT_BUSINESS_NAVIGATION` 十项权威清单已直接中文化为总览、通知、邮件草稿、本地采购、进口采购、风险看板、供应商、服务等级、高级服务等级、配置；五个生命周期阶段标签同步直接中文化。路由 ID、图标、顺序、owned deep links、API 和业务数据合同未变。`employee-packs.ts` 的采购路径、报表、设置分组继续只重排 Manifest 入口，不伪造路由。
- TDD 证据：中文权威清单与生命周期断言先对英文生产清单出现 2 项预期 RED，生产源码修改后 `procurement-employee-pack.test.ts` 与 `employee-packs.test.ts` **7/7**；登录交互与源码检查 **3/3**。4174 控制面使用规定的 Node 24 重新启动，浏览器随后从真实 `/api/employee-packs` 读回十项中文清单。
- 新 `verify-auth-shell-round.ts` 在 1280×720、1440×900、1920×1080 验证本地密码、企业身份提供方未接入、服务不可用恢复和已登录采购外壳，并额外验证会话过期，共 **13** 个状态。覆盖密码显隐、同周期两次 submit 只发 1 个登录请求、十项导航顺序、侧栏折叠/展开、通知与用户菜单、会话过期清空密码和全局无横向溢出。pageerror 0、非预期 console error/warning 0、生产业务写请求 0；401/503 仅为隔离认证场景的预期响应。
- 主代理目视检查本地密码1280、企业身份提供方1440、服务不可用1920、已登录外壳1280/1920和会话过期1920截图，未见截断、错位或英文系统导航。证据、13张截图 SHA-256 与8个源码 SHA-256：`artifacts/alignment-20260906/verification-auth-shell-round-results.json`。

本轮只重启控制面 API 以加载新 Manifest；Business API 仍是此前进程，尚未部署后续文档/历史后端改动。未发送邮件、未审批订单、未发布 SLA、未导入数据、未操作真实连接器。登录/全局壳范围关闭，但开发者控制面和全平台完整状态矩阵仍未完成，整体目标保持进行中。

## 后续源码轮：开发者控制面与员工编译器

- `workflow-canvas.tsx` 的 React Flow 控制面、放大、缩小、适配、缩略图、节点、连线、端口和辅助说明均为直接中文源码；`1 in / 1 out` 已改为中文数量。缩放和全屏原先共用“放大画布”无障碍名称，真实 DOM 证明同名后改为“放大画布”与“全屏显示画布”两个独立动作。
- `CreateEmployeeWizard` 增加 `role="dialog"`、`aria-modal`、标题关联、初始焦点、Tab/Shift+Tab 闭环、Escape 关闭、触发按钮回焦和开启期间页面滚动锁定。
- 配置页保持已批准的渐进披露：默认只显示常规设置和智能体设置；从“邮件智能体 → 详情”打开高级治理和连接器控制面。浏览器验收已真实点击该路径，而非直接假设隐藏内容已可见。
- `verify-developer-control-round.ts` 在 1280×720、1440×900、1920×1080 三视口依次用 Enter、Space、鼠标覆盖编排/运行/规则/测试/版本/日志六页签、画布控制、员工编译器和连接器搜索；最终 **24** 项，页面异常 0、控制台异常 0、失败响应 0、业务写尝试 0。
- 证据与 24 张截图 SHA-256：`artifacts/alignment-20260906/verification-developer-control-round-results.json`。本次修改后 root typecheck、Console typecheck、定向 ESLint 均 exit 0；开发者/Employee Pack 定向 6/6，登录/法律/画布真实渲染 4/4。

本轮不使用生产业务写操作，未创建员工、未操作连接器、未发送邮件、未审批订单、未发布 SLA。开发者控制面定向范围已有完整本轮证据，但 Advanced SLA、十主页和 PO 全状态仍未穷尽，整体目标保持进行中。

## 后续源码轮：Advanced SLA 治理与边界矩阵

- `advanced-sla-workbench.tsx` 原先允许在 CSV 应用请求未决时用 Escape 或关闭按钮卸载对话框。新的真实组件测试先稳定 RED，然后为通用 Modal 增加进行中关闭门禁；应用期间 Escape/关闭/取消均不卸载，同周期双击只发 1 次 POST，409 后保留 CSV 候选与对话框。
- Advanced SLA 组件交互现为 **9/9**：九域字段中文与枚举值、时长单位、业务原文保护、只读、More 键盘/回焦、规则保存防重、409 保留输入、CSV 校验/应用/刷新及 CSV 进行中门禁。
- `verify-advanced-governance-matrix.ts` 启动临时 SQLite 和真实 `handleProcurementAdvancedSlaRequest`，不使用生产业务库。1280×720 验证采购专员只读与详情可读；1440×900 验证真实非法 CSV 422、权限变化 403、外部并发更新 409 及输入保留/显式刷新；1920×1080 验证发布、暂停、恢复、退役及 runtime control 版本 1→2→3。
- 最终矩阵 **9** 项，预期错误响应精确为 403/409/422，页面异常 0、非预期控制台异常 0、生产业务写 0；隔离订单摘要不变、Outbox 0、最终已发布配置 0、已退役配置 1。五张截图已目视复核关键状态，无弹窗越界或全局横溢出。
- 证据、请求记录、截图及四个源文件 SHA-256：`artifacts/alignment-20260906/verification-advanced-governance-matrix-results.json`。本次修改后 root typecheck、Console typecheck、定向 ESLint 与 9/9 交互回归均 exit 0；原有配置隔离浏览器验收也再次 exit 0。

此轮所有发布、暂停、恢复、退役只作用于自动创建的临时数据库；未发送邮件、未更新 ERP、未审批订单、未操作真实连接器。Advanced SLA 本轮核心桌面矩阵已有直接证据，但全平台目标仍因其他页与 PO 全状态未穷尽而保持进行中。

## 后续源码轮：十个一级页面运行时几何对齐

- Notifications 与邮件草稿保留 124.25px 集成页头和原筛选位置，只校正页面自有标题内边距；标题均从 y=42 对齐到参考 y=34。
- 本地/进口采购保留全部 29 张真实待分类订单、查看、确认路线和刷新行为，将该面板移到主路线工作台之后。标题为 y=12，阶段栏 y=143，搜索框 y=208；主表和助手不再被待分类面板向下挤压。
- Risk 标题和日期/筛选/导出控件分别对齐 y=70，三项头部控件统一为 36px 高。Supplier 与 SLA 使用统一 26px/700/39px 标题令牌，标题 y=34、搜索 y=181、顶部动作 y=21。Advanced SLA 为标题 y=34、首规则域 y=172.3、搜索 y=258.3。Configuration 为标题 y=34、国家控件 y=284、保存动作 y=21。
- 最终只读浏览器记录时间 `2026-09-06T08:25:05.478Z`，十页 × 三视口共 **30/30** 张截图；10/10 页面坐标失败 0、文档横向溢出 0、pageerror 0、console error/warning 0、失败读取 0、业务写尝试 0。主代理目视检查 Local 1280、Supplier 1440、Risk 1920、Advanced SLA 1440、Configuration 1920，未见截断、重叠或层级异常。
- 定向边界测试 **22/22**、八页点击/键盘/焦点/权限/版本交互 **35/35**；root typecheck、Console typecheck、Console 定向 ESLint、生产 build 均 exit 0。最终独占资源运行的注册套件为 **771 + 1 + 174 = 946/946**。
- 一次把全量测试、两个 TypeScript 检查与 ESLint 并行运行时，两个既有 PO 文档子进程用例精确撞上 60s/30s 超时；未修改相关源码，隔离复跑 2/2 后，再独占资源完整重跑为 946/946。最终证据不使用该资源竞争失败轮。
- 完整坐标、命令结果、安全计数与目视记录：`artifacts/alignment-20260906/verification-top-level-geometry-round-results.json`；30 张截图目录：`top-level-geometry-round/`；18 个源码/测试/验证结果和 30 张截图的 SHA-256：`verification-top-level-geometry-round-sha256.txt`。

**本轮未发送邮件、未审批或取消订单、未发布 SLA、未操作真实连接器、未导入生产数据，也未重启生产 Business API。** 此轮关闭十个一级页面的当前正常桌面几何，不从几何 GREEN 推断正常/空/加载/错误、401/403/404/409/422、connector、pending/unknown、kill-switch 或 PO 六页签组合矩阵全部完成；全平台目标继续进行。

## 后续源码轮：风险看板适用状态与参考密度收口

- `risk-dashboard.tsx` 初次读取期间保留 H1、日期/筛选/导出控件和稳定骨架，明确 `aria-busy`；加载态不闪空态、不自动创建快照。GET 权威返回 `capabilities.refresh`，只读审计员不显示创建/更新动作；读取后权限被撤销时，真实 403 保留不可变快照且不显示虚假成功。
- API 的风险等级与采购路线 422 用户文案已中文化，同时保持 HTTP 422、`INVALID_RISK_RANGE` 及 `high/medium/low`、`local/import/unclassified` 稳定枚举不变。legacy 快照不再显示 V2 权重说明；空 `riskBreakdown` 使用固定雷达刻度键，消除重复 React key 错误。
- 隔离验证记录时间 `2026-09-06T09:47:33.960Z`（北京时间 `2026-09-06 17:47:33.960`）。14 类状态——初始加载、操作员空态、审计员空态、V2 当前快照、无匹配筛选、缓存读取失败、401、403、真实 422、三种陈旧原因、legacy、读取后权限撤销——在 1280×720、1440×900、1920×1080 三视口共 **42/42** 通过。
- 每个适用正常渲染的 H1 为 26px/700，七个分析标题为 15px/600，日期/筛选/导出控件均为 36px；页面横向溢出 0，宽表横滚限制在表格容器内。筛选/日期 Escape 回焦和筛选后导出查询一致性均有浏览器断言。
- 预期失败读取共 15 次：缓存 503、初始 401、初始 403、真实 422、刷新权限撤销 403 各三视口一次；非预期失败读取 0、pageerror 0、非预期 console error/warning 0、生产业务写尝试 0，隔离订单摘要未变，隔离 Outbox 0。404、409、连接器未就绪、外部 pending/unknown 与 kill-switch 按端点契约记录为不适用，没有伪造页面状态。
- 主代理目视检查加载1280、V2当前1920、审计员空态1440、缓存错误1920、三种陈旧原因各一张、legacy1440、权限撤销1280共 **9** 张代表截图，未见裁切、重叠、英文系统占位或误导性成功。
- 当前注册全量测试为 `pnpm test` **772 + 1 + 176 = 949/949**；root/Console TypeScript、Console 定向 ESLint、生产 build 均 exit 0。结果：`artifacts/alignment-20260906/verification-risk-dashboard-matrix-round-results.json`；42 张截图：`risk-dashboard-matrix-round/`；验证器：`verify-risk-dashboard-matrix-round.ts`。
- 七个源码/测试/验证器文件、结果 JSON 与 42 张 PNG 共 **50** 个对象已写入 `verification-risk-dashboard-matrix-round-sha256.txt`，并由 `shasum -a 256 -c` 全部验证为 OK。

**本轮只向自动创建的临时 SQLite 写入 1 个风险快照；未触及生产 Business API、正式数据库、Outbox、Odoo、邮件、WhatsApp 或其他连接器。** 风险看板这一切片已关闭；十个一级页面与 PO 六页签的其余完整状态/键盘/连接器组合矩阵，以及最新 Business API 源码的生产部署与运行态复验仍未关闭，全平台目标继续进行。

## 后续源码轮：总览、通知与邮件草稿全状态收口

- 总览在首次加载和首次失败期间持续保留 H1、日期控件和稳定骨架，不把缺失数据伪装成零指标；中文日期范围保持单行。真实 PO 深链中供应商运营档案地址为 JSON `null` 时，PO Context 现安全返回 `address: null` 而不是 503；完整采购工作台 API 文件回归已纳入全量门禁。
- 通知 GET 返回权威 `capabilities.markRead`；只读用户仍可导航，但不发出已读写入。中途撤销权限时，403 保留权威未读计数和行状态，不显示假成功。
- 邮件草稿 GET 独立返回 `edit` / `discard` / `approve` 三项权限：管理员三项可用，专员仅编辑/丢弃，审计员只读，缺少 capability 的未部署后端默认 fail closed。编辑 409/422 和审批 403 保留选中草稿与用户输入；只有连接器真实回执才可显示已发送。
- 隔离 HTTP/SQLite 浏览器矩阵记录时间 `2026-09-06T11:20:20.689Z`。总览 7 类、通知 12 类、邮件草稿 17 类，共 **36 类状态 × 3 视口 = 108/108**；覆盖 401/403/404/409/422/503，并逐端点记录不适用状态，不伪造错误。
- 矩阵中非预期失败响应、page error、非预期 console error/warning、外部请求、生产 Business API 写入尝试与非预期写入均为 0；源 PO/文档摘要不变。隔离 Outbox 仅保留两个明确批准的验收事实：连接器阻断的 `blocked` 和连接器就绪后入队的 `pending`，未启动派发 worker。
- 主代理目视复核指定的 11 张代表截图，未发现裁切、重叠、英文系统 UI、缺失焦点环或误导性成功。完整请求日志、适用性、108 张截图哈希与 12 个源码/验证器哈希见 `artifacts/alignment-20260906/verification-overview-notifications-drafts-matrix-results.json`。
- 当前发布门禁为：聚焦 API/边界 16/16，三页 React 交互 20/20；root TypeScript、Console TypeScript、定向 ESLint 和 Console production build 均 exit 0；串行全量 `pnpm test` 为 **773 + 1 + 185 = 959/959**。
- SHA-256 冻结清单 `artifacts/alignment-20260906/verification-overview-notifications-drafts-matrix-sha256.txt` 包含 14 个源码/测试/验证器对象、1 个结果 JSON 和 108 张 PNG，共 **123/123** 通过 `shasum -a 256 -c`。

**本轮未发送邮件或 WhatsApp、未审批/取消正式订单、未发布正式 SLA、未操作 Odoo/连接器或生产数据。** 总览、通知与邮件草稿这一切片已关闭；本地/进口采购、供应商/基础 SLA/配置、PO 六页签/动作的剩余组合矩阵以及最新 Business API 生产部署与运行态复验仍未关闭，全平台 100% 目标保持进行中。

## 后续源码轮：本地/进口采购完整状态与动作收口

- 本地/进口采购继续共用 `ProcurementRouteWorkbench` 和稳定路线值 `local` / `import`。首次加载、真实空态、首次错误和缓存刷新错误保持不同；管理者、采购专员、审计员及缺失权限载荷均由服务端 capability fail-closed 控制。跟进、RIHD、人工风险、路线确认、路线证据、路线助手附件与权威导出全部增加同步单飞、幂等重放、冲突输入保留和 pending/processing/blocked/failed/unknown/dispatched 诚实状态。
- 路线人工确认新增迁移 52 的租户级持久幂等回执；同键同载荷重放一次结果，同键异载荷返回 409，业务事实、事件与回执在一个事务中提交或回滚。权威路线 CSV 的十个系统表头、已知风险、完成状态和行操作均为中文，供应商、物料、PO 编号、币种、精度及其他业务原文保持不变。
- 隔离浏览器矩阵记录时间 `2026-09-06T17:32:38.156Z`（北京时间 `2026-09-07 01:32:38.156`）。两个路线 × 三个视口覆盖 **137 个场景、411/411 项检查、477 张权威截图**；读取、助手附件、行操作、路线证据、持久化和目检六项 applicability 均为 `complete`。
- 预期失败响应共 207 次，只来自指定场景的 401、403、404、409、422、503；410 与 500 对本切片当前端点契约不适用，未伪造对应页面状态。非预期失败响应、非预期 Console error/warning、page error、外部请求、未允许写入、生产 Business API 写入尝试和已启动 Worker 均为 **0**。
- 所有浏览器写入只作用于自动创建的临时 SQLite 与内存对象存储。全新只读重开后，行操作六轮精确得到 6 个草稿、6 个草稿事件、6 个手工风险、24 个 RIHD Outbox 与精确幂等回执；管理者六轮精确得到每路线 9 个导出、18 个附件及隔离聊天；路线证据六轮精确得到每路线 6 个当前分配、24 个分配回执和 24 个证据文档。非目标租户与源 PO/PO 行保持不变；临时数据库目录已在 `finally` 中删除并确认不存在。
- 19 张指定代表截图已目视复核：加载、正常、审计员、缓存 503、真实空态、附件阻断、AI pending、中文导出、跟进 409、RIHD blocked/pending/unknown/dispatched、风险 422、路线合同/扫描中/409/撤销。未见裁切、重叠、英文系统标签、缺失交互状态、路线泄漏或误导性成功；长弹窗保持视口边界并使用内部纵向滚动。
- 发布门禁为：聚焦 API/持久化/边界 **34/34**，真实 React 交互 **14/14**；root TypeScript、Console TypeScript、定向 ESLint 和 Console production build 均 exit 0；最终串行全量 `pnpm test` 为 **775 + 1 + 195 = 971/971**。全量测试同时纠正了一个仍要求旧“管理员，您好”文案的陈旧边界断言，真实组件回归继续要求角色中立“您好”且禁止硬编码管理员称呼。
- 完整请求、适用性、精确持久化、目检、清理及源码/截图哈希见 `artifacts/alignment-20260906/verification-local-import-matrix-results.json`。冻结清单 `artifacts/alignment-20260906/verification-local-import-matrix-sha256.txt` 覆盖源码、测试、验证器、结果 JSON 与本次结果引用的 477 张截图，共 **500/500** 个对象通过 `shasum -a 256 -c`。

**本轮未发送邮件或 WhatsApp、未调用 Odoo、未提交正式审批、未导入或修改生产数据，也未启动外部派发/文档 Worker。** 本地采购与进口采购切片现已关闭；供应商、基础 SLA、配置的完整适用状态矩阵，PO 六页签/五项 Actions 的剩余组合矩阵，以及最新 Business API 源码的生产部署与运行态复验仍未关闭。全平台 100% 目标继续进行。

## 后续源码轮：供应商、基础 SLA 与配置全状态收口

- 供应商目录权限由服务端 `read/configure` 权威返回；必需目录与可选绩效/交期源独立失败，旧数据刷新失败保留并标记过期。创建、编辑、停用/重启与交期写入均同周期单飞，403/409/422/结果未知保留已审输入并要求权威重读。供应商 More 菜单使用 Radix wrapper，规定名称不被触发器覆盖；Home/End 显式在非禁用 `[role="menuitem"]` 间移动，Escape 和对话框关闭均返回原触发器。
- 基础 SLA 目录与可选自动化源已隔离；加载、真空、草稿、发布、退役、缓存失败和自动化失败不再互相冒充。configure/approve/operate 分权限制 Add/Edit/Duplicate/Delete/Publish/Retire/Evaluate/Run Automation，所有生命周期写入单飞且成功后重读真实 handler。
- 配置连接摘要使用最新读取胜出，首次失败不伪造“未配置”，缓存刷新失败保留上次权威四卡。Email、Meta WhatsApp Cloud API、WeChat、ERP/Odoo 分层与角色权限均按服务端事实；七道 auto-send 门禁任一阻断时开关禁用，不生成本地假成功。偏好写入覆盖单飞、403/409/422/结果未知、明确重读与刷新持久化。
- 隔离浏览器矩阵于 `2026-09-07T04:17:36.021Z`冻结：供应商 21 类、基础 SLA 22 类、配置 29 类，共 **72 类×3视口=216/216** 检查和 216 张截图。预期失败响应 227 次：401=63、403=70、404=3、409=12、422=12、503=67；非预期失败、Console error/warning、page error、外部请求、辅助读失败、越权/未允许写入、生产 Business API 写入尝试和 Worker 启动均为 **0**。
- 所有写验收只作用于自动创建的临时 SQLite 和内存连接器快照。全新 handler 重开确认：供应商主数据/Profile 精确版本、状态和 27 条 Profile 事件，4 条交期与 13 条交期事件；三个 SLA 写入租户均为两份 retired 策略、12 条策略事件、2 条评估事件、1 次自动化运行/租约，Draft/Outbox 均 0；配置偏好最终为 `JP / Europe/London / DD MMM YYYY / v7`且有 6 条偏好事件。临时数据库目录已在 `finally` 删除并确认不存在。
- 21 张指定代表截图已目视复核：无裁切/重叠、无英文系统占位、交互/焦点状态可见、无伪造零值/成功、无隐藏授权动作、无页面级水平溢出。业务原文、连接器健康原文与稳定标识依要求保留，不作为系统 UI 翻译。
- 聚焦 API **47/47**、四页 React **37/37**；root TypeScript、Console TypeScript、定向 ESLint 与 Next.js 16.3.3 production build 均 exit 0；串行全仓 `pnpm test` 为 **778 + 1 + 223 = 1002/1002**。结果及请求/持久化/安全计数见 `artifacts/alignment-20260906/verification-supplier-sla-configuration-matrix-results.json`。SHA-256 清单 `verification-supplier-sla-configuration-matrix-sha256.txt` 覆盖 33 个源码/测试/验收器、216 张 PNG 和结果 JSON，共 **250/250 OK**。

**本轮未触及正式 SQLite，未发送 Email/WhatsApp，未调用 Odoo，未发布正式 SLA，也未启动外部 Worker。** 供应商、基础 SLA 与配置切片在该阶段把总账推进到 **32/41（78.0%）**；其余 9 项已由下方最终收口关闭。

## 最终收口：PO 全矩阵与生产运行态

- 最终 PO 验收结果生成于 `2026-09-07T06:12:42.296Z`：Overview、Items、Supplier、Documents、History、Communication 六页签 **144/144**；Edit、Mark as、Duplicate、Print、Cancel 五项 Actions **108/108**；合计 84 场景 × 3 视口 = **252/252**。
- 三个视口均使用独立登录与浏览器上下文；最终 `unexpectedConsole=0`、`pageErrors=0`、`externalRequests=0`、`productionBusinessMutationAttempts=0`、`startedWorkers=0`，并冻结 252 张截图哈希。完整证据：`artifacts/alignment-20260906/verification-po-six-tabs-actions-matrix-results.json`。
- 全仓注册测试为 **779 + 1 + 223 = 1003/1003**；React 定向测试 **14/14**；root/Console TypeScript、定向 ESLint 与 Next.js 16.3.3 production build 全部通过。
- 生产运行态只读复验确认：3001 Console 可登录；4173 `/health` 为 `business`，4174 `/health` 为 `control`；Employee Pack 读取 2 项，真实工作台读取 20 张 PO 和 12 个供应商；正式业务写请求与外部请求均为 0。证据：`artifacts/alignment-20260906/verification-production-api-runtime-results.json`。
- 最终 SHA-256 清单包含 252 张截图、11 个矩阵源码/参考对象和 12 个补充源码/测试/结果对象，共 **275/275** 验证通过：`artifacts/alignment-20260906/verification-po-six-tabs-actions-matrix-sha256.txt`。
- 当前租户生产就绪度诚实保持 **6/11 blocked**；这五项业务/安全阻断不影响源码、页面、点击、键盘、焦点、刷新和真实数据链路的工程对齐结论。

最终工程总账：**41/41（100%）**。验收完成。
