# 供应商回信证据自动化设计

## 目标

把已经完成身份校验并落库的真实供应商邮件交给 DeepSeek 做结构化提取，在严格逐字段原文校验通过后，自动登记采购路线、供应商承诺、生产/备货进度和 ASN/Shipment；刷新页面后必须显示这些真实持久化事实。GRN 仍只能由真实 Odoo/WMS 入库完成事实生成。

## 范围与边界

- 输入必须是现有 IMAP 链路已验证供应商身份、已关联 PO 且已持久化的入站 `Communication`。
- AI 只产生候选结构，不拥有业务写权限；服务端验证每个候选值和对应 `quote` 是否能在当前回复正文逐字找到。
- 订单原值只用于行身份、币种和上限校验，不能填补供应商未说明的数量、价格、日期、完成度或 ASN 信息。
- 不能仅凭供应商名称、城市、仓库或中文地址判断本地采购。路线只接受明确的“境内/国内/本地采购（或发货）”和“进口/境外/海外采购（或发货）”表述。
- AI 生成的生产和发运事实必须标记为 `supplier_email_ai`，来源系统为 `supplier-email-ai`，证据引用为入站邮件 `communicationId`；绝不能写成 `manual_verified`。
- 供应商邮件不得直接生成运输签收、仓库收货或 GRN。
- 已存在冲突路线、重复 ASN、订单版本变化或状态不允许时保留 AI 结果并转人工核验，不覆盖既有事实。
- 所有写入使用稳定幂等键；同一封邮件重放不重复调用模型、不重复写路线、生产进度或 Shipment。

## 结构化候选

保留现有 `intent`、`ambiguous`、`summary` 与逐行确认字段，并增加三个可选区块：

- `route`: `value` 为 `local | import`，`quote` 为当前回复中的明确路线原句。
- `production`: 包含逐行 `progressStatus`、`completionPercent`、`completedQty`、可选 `expectedReadyDate` 和各自原文引用。标记 `ready_to_ship` 时必须明确写出 100% 和完成数量，且覆盖有效订购量。
- `shipment`: 包含 `supplierReference`（ASN/发运单号）、`carrier`、`trackingNumber`、`estimatedArrivalDate` 及逐行发运数量，并为每个值提供原文引用。

模型可以返回部分候选，但只有完整、无歧义并通过规则验证的区块才进入业务状态机。未通过的区块留在分析结果里并说明原因。

## 服务端数据流

1. IMAP 读取邮件并用现有发件人、Message-ID、邮箱 UID 和 PO 线程规则完成身份与幂等校验。
2. 保存 `Communication`，截断转发/引用历史，仅把当前回复送入 DeepSeek。
3. 校验模型 JSON、PO 行映射、原文引用、数值、日期、路线关键词及 ASN 字段。
4. 按路线、承诺、生产、发运顺序应用已验证区块，每一步重新读取 PO 版本。
5. 每个业务动作写持久化事实、阶段事件和实时事件；失败区块不回滚已经合法写入的独立区块，但分析结果记录逐区块结果。
6. 前端通过现有轮询/实时刷新重新读取 PO，并在 AI 分析卡中显示已应用区块、证据来源和待核验原因。

## 证据与权限模型

- Web 表单仍只能由有审批权限的人生成 `manual_verified` 事实。
- 内部 AI 路径使用固定 actor `ai:supplier-reply`，只允许 `supplier_email_ai`，且仓储层必须反查证据引用对应的入站邮件属于同租户、同 PO、同供应商。
- 生产和 Shipment 文档保存 `evidenceSource: supplier_email_ai`、`evidenceReference: communicationId`；不保存密钥，不把模型响应当作来源事实。
- 路线记录保存 `source: supplier_email_ai`，证据包含 `communicationId`、明确路线原句、模型名称和 PO 版本。
- 记录 Shipment 只证明供应商声称已发运；后续 GRN 以 Odoo/WMS 权威回读为准。

## 错误处理

- JSON 无效、原文不支持、缺字段、行映射不完整：区块状态 `review_required`，不写事实。
- 模型/凭据故障：沿用现有三次限次重试和脱敏错误。
- 已有路线与新路线冲突：不覆盖，标记人工核验。
- 已存在相同 ASN 或相同邮件事实：幂等重放返回原结果。
- 多区块邮件部分成功：分析总状态为 `partially_applied`，明确列出成功和待核验区块。

## 前端

AI 回信解析卡显示：

- 总状态：已更新订单、部分更新、差异待审批、待人工核验或失败。
- 已验证路线及“供应商邮件 + AI 原文校验”来源。
- 行级承诺、生产完成度/完成数量/预计可发运日。
- ASN、承运商、运单号、ETA 和行级发运数量。
- 每个未应用区块的具体原因。

页面不得把 AI 事实显示成“人工核验”或“ERP 回读”。

## 验证标准

- 单元测试证明伪造 quote、模糊路线、缺失 ASN 字段、跨 PO 邮件和版本冲突均不会写事实。
- 集成测试证明一封真实格式邮件可以依次完成路线、承诺、生产和 Shipment，重放不重复写入。
- 持久化测试证明来源字段、邮件证据引用、阶段事件和 PO 状态准确。
- 前端测试证明解析卡显示新增事实和中文来源标签。
- 运行 API、Console、Temporal Worker 后，用真实邮箱回信验证 IMAP 入库、DeepSeek 解析、数据库事实和浏览器页面一致。
- 最终 11/11 仍要求 Odoo/WMS 将真实入库单完成并被 Readywork 回读为 GRN。
