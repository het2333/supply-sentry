# 供应商回信证据自动化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让真实、已验证的供应商邮件通过 DeepSeek 和严格原文校验，自动持久化路线、承诺、生产/备货及 ASN/Shipment，并在前端准确显示来源。

**Architecture:** 扩展现有 `procurement-ai-reply` 候选与验证器，复用采购执行状态机，但为内部 AI 邮件事实增加独立 `supplier_email_ai` 证据路径。路线使用专用内部幂等写入函数；各区块按顺序应用并返回逐区块结果，前端只渲染后端持久化结果。

**Tech Stack:** TypeScript、Node.js 22、node:sqlite、Node test runner、React 19、Next.js、DeepSeek Chat Completions、SMTP/IMAP。

**Spec:** `docs/superpowers/specs/2026-09-08-supplier-reply-evidence-automation-design.md`

## Global Constraints

- 禁止 Mock、伪造或把订单原值当作供应商回复事实。
- 所有 AI 字段必须有当前回复中的逐字 `quote`，并由确定性代码复核。
- AI 生产与发运事实必须标记 `supplier_email_ai`，不能标记 `manual_verified`。
- 路线不能从“上海”等地名、供应商名称或仓库推断。
- GRN 只能来自真实 Odoo/WMS 完成回读。
- Temporal Worker 继续使用真实 DSH，不能切换到 inmemory。
- 当前目录不是 Git 仓库，因此本计划不执行 Git commit；每个任务以通过定向测试作为检查点。

---

### Task 1: 来源感知的生产与发运仓储契约

**Files:**
- Modify: `packages/core/src/procurement-model.ts`
- Modify: `packages/persistence/src/index.ts`
- Test: `packages/persistence/test/procurement-persistence.test.ts`

**Interfaces:**
- Consumes: 已持久化、同租户同 PO 的入站邮件 `Communication`。
- Produces: `ProcurementExecutionEvidenceSource = 'manual_verified' | 'supplier_email_ai'`；现有 `record_production_progress` 和 `record_shipment` 可在内部可信路径记录邮件 AI 事实。

- [x] **Step 1: 写失败测试**

新增两个用例：`supplier_email_ai` 生产进度与 Shipment 只有在 `evidenceReference` 指向同 PO、同供应商的真实入站邮件且 actor 为 `ai:supplier-reply` 时成功；伪造/跨 PO 引用失败。断言文档和阶段事件保存 `sourceSystem='supplier-email-ai'`、`evidenceSource='supplier_email_ai'`，且不出现 `manual_verified`。

- [x] **Step 2: 运行失败测试**

Run: `pnpm exec tsx --test --test-name-pattern='supplier_email_ai' packages/persistence/test/procurement-persistence.test.ts`

Expected: FAIL，因为核心类型和仓储层尚只接受 `manual_verified`。

- [x] **Step 3: 最小实现**

在核心类型中加入来源联合类型；把 `requireManualVerification` 拆为人工和供应商邮件两条服务端验证路径。邮件路径反查 `procurement_documents.kind='communication'` 的 JSON，要求 `direction='inbound'`、`channel='email'`、`businessObjectId` 和 `supplierId` 与当前 PO 一致，并要求 actor 固定为 `ai:supplier-reply`。生产与 Shipment 根据来源写准确的 `sourceSystem`、`sourceKind`、`evidenceSource`、`evidenceReference`；运输事件和 GRN 继续只允许人工/Odoo 现有路径。

- [x] **Step 4: 运行定向测试与类型检查**

Run: `pnpm exec tsx --test --test-name-pattern='supplier_email_ai' packages/persistence/test/procurement-persistence.test.ts`

Expected: PASS。

Run: `pnpm typecheck`

Expected: PASS。

---

### Task 2: 供应商邮件路线的幂等写入

**Files:**
- Modify: `apps/api/src/procurement-routes.ts`
- Modify: `apps/api/src/procurement-workbench.ts`
- Test: `apps/api/test/procurement-routes.test.ts`
- Test: `apps/api/test/procurement-workbench.test.ts`

**Interfaces:**
- Consumes: `{db, tenantId, poId, communicationId, route, quote, model, at}`。
- Produces: `recordSupplierEmailRouteAssignment(...)`，结果为 `applied | replayed | conflict`，并保存 `source='supplier_email_ai'`。

- [x] **Step 1: 写失败测试**

覆盖明确“本订单为境内采购”的 local 写入、同邮件重放、既有相同路线不覆写、既有冲突路线返回 conflict、跨 PO 邮件拒绝，以及工作台返回 `source='supplier_email_ai'`。

- [x] **Step 2: 运行失败测试**

Run: `pnpm exec tsx --test --test-name-pattern='供应商邮件路线' apps/api/test/procurement-routes.test.ts apps/api/test/procurement-workbench.test.ts`

Expected: FAIL，因为内部写入函数和来源展示尚不存在。

- [x] **Step 3: 最小实现**

导出 `recordSupplierEmailRouteAssignment`。函数校验入站邮件归属、路线 quote 及 PO 版本，使用 `ai-reply-route:<communicationId>` 作为稳定幂等键；没有路线时插入，有相同路线时保持原版本，有冲突时不覆盖。更新工作台来源联合类型和输出，保留真实数据库 `source`。

- [x] **Step 4: 运行定向测试**

Run: `pnpm exec tsx --test --test-name-pattern='供应商邮件路线' apps/api/test/procurement-routes.test.ts apps/api/test/procurement-workbench.test.ts`

Expected: PASS。

---

### Task 3: DeepSeek 多区块提取与严格原文校验

**Files:**
- Modify: `apps/api/src/procurement-ai-reply.ts`
- Test: `apps/api/test/procurement-ai-reply.test.ts`

**Interfaces:**
- Consumes: 当前回复正文、PO、PO 行、收信时间。
- Produces: `ValidatedReplyFacts`，包含可选 `confirmation`、`route`、`production`、`shipment` 与逐区块校验结果。

- [x] **Step 1: 写路线失败测试**

证明明确“本订单为境内采购”可验证，而只有“上海发货”、伪造 quote、同时出现境内和进口关键词都必须 `review_required`。

- [x] **Step 2: 运行路线测试确认 RED**

Run: `pnpm exec tsx --test --test-name-pattern='AI 路线' apps/api/test/procurement-ai-reply.test.ts`

Expected: FAIL，因为候选结构还没有 route。

- [x] **Step 3: 实现路线候选和验证器并跑绿**

扩展系统提示词和类型；新增确定性路线验证，只接受 quote 中明确路线语义。运行同一命令，Expected: PASS。

- [x] **Step 4: 写生产失败测试**

覆盖单行 `ready_to_ship` 的明确数量、100%、日期和原文引用；缺少数量、完成度、伪造 quote、超过有效订购量、多行缺物料引用均拒绝。

- [x] **Step 5: 运行生产测试确认 RED**

Run: `pnpm exec tsx --test --test-name-pattern='AI 生产' apps/api/test/procurement-ai-reply.test.ts`

Expected: FAIL，因为候选结构还没有 production。

- [x] **Step 6: 实现生产候选和验证器并跑绿**

复用数值、日期、行映射校验；不从订单默认填值。运行同一命令，Expected: PASS。

- [x] **Step 7: 写 Shipment 失败测试**

覆盖 ASN、承运商、运单号、ETA、行级发运数量全部有原文证据时通过；缺字段、伪造字段、重复行、超量均拒绝。

- [x] **Step 8: 运行 Shipment 测试确认 RED**

Run: `pnpm exec tsx --test --test-name-pattern='AI 发运' apps/api/test/procurement-ai-reply.test.ts`

Expected: FAIL，因为候选结构还没有 shipment。

- [x] **Step 9: 实现 Shipment 验证器并跑绿**

验证 ASN 标识、文本字段逐字引用、ETA 日期和数量上限。运行同一命令，Expected: PASS。

---

### Task 4: 顺序应用、部分成功与幂等重放

**Files:**
- Modify: `apps/api/src/procurement-ai-reply.ts`
- Test: `apps/api/test/procurement-ai-reply.test.ts`

**Interfaces:**
- Consumes: Task 2 路线写入函数和 Task 3 的 `ValidatedReplyFacts`。
- Produces: `AiReplyAnalysis.appliedFacts`、`blockResults`、`status='applied' | 'partially_applied' | 'review_required'`。

- [x] **Step 1: 写端到端失败测试**

一封单行 PO 回信同时包含明确境内路线、数量/价格/交期确认、100% 完成数量、ASN、承运商、运单和 ETA。断言按路线→确认→生产→Shipment 应用，PO 最终为 `shipped`，五阶段前四段有准确状态/来源；第二次摄取模型调用次数仍为 1，事实数量不增加。

- [x] **Step 2: 运行测试确认 RED**

Run: `pnpm exec tsx --test --test-name-pattern='一封供应商邮件完成' apps/api/test/procurement-ai-reply.test.ts`

Expected: FAIL，因为当前只应用确认。

- [x] **Step 3: 最小实现顺序应用器**

每一步重新读取 PO 版本并使用 `ai-reply-<fact>:<communicationId>` 幂等键；生产与 Shipment 调用仓储状态机时传 `actorId='ai:supplier-reply'`、`permission='operate'`、`evidenceSource='supplier_email_ai'`、`evidenceReference=communicationId`。部分失败保留已成功事实并写 `blockResults`。

- [x] **Step 4: 运行 AI 回信完整测试**

Run: `pnpm exec tsx --test apps/api/test/procurement-ai-reply.test.ts`

Expected: PASS。

---

### Task 5: 前端真实来源与多区块展示

**Files:**
- Modify: `apps/console/features/procurement/ai-supplier-reply-analysis.tsx`
- Test: `apps/console/test/ai-supplier-reply-analysis-interaction.test.tsx`

**Interfaces:**
- Consumes: 后端 `AiReplyAnalysis` 的 `verifiedRoute`、`productionLines`、`shipment`、`blockResults`。
- Produces: 中文、可刷新持久化的 AI 解析卡。

- [x] **Step 1: 写失败测试**

渲染一份后端分析结果，断言显示“供应商邮件 + AI 原文校验”、本地采购、生产 100%、ASN、承运商、运单号和 ETA；不得显示“人工核验”。覆盖 `partially_applied` 中文状态。

- [x] **Step 2: 运行测试确认 RED**

Run: `pnpm --dir apps/console exec tsx --test test/ai-supplier-reply-analysis-interaction.test.tsx`

Expected: FAIL，因为组件当前只显示确认字段。

- [x] **Step 3: 最小实现并跑绿**

在现有卡片中增加已验证路线、生产、发运和逐区块原因；沿用后端状态，不创建前端假数据。运行同一命令，Expected: PASS。

- [x] **Step 4: 前端类型与构建检查**

Run: `pnpm typecheck`

Expected: PASS。

Run: `pnpm --dir apps/console build`

Expected: PASS。

---

### Task 6: 全链回归和真实邮箱验证

**Files:**
- Modify only if a failing regression identifies a scoped defect.

**Interfaces:**
- Consumes: 运行中的 Control API、Business API、Console、Temporal Worker、真实 SMTP/IMAP、DeepSeek、Odoo。
- Produces: 可审计的一张真实本地采购 PO 证据链。

- [x] **Step 1: 运行定向回归**

Run: `pnpm exec tsx --test packages/persistence/test/procurement-persistence.test.ts apps/api/test/procurement-ai-reply.test.ts apps/api/test/procurement-inbound-email.test.ts apps/api/test/procurement-inbound-mail-monitor.test.ts apps/api/test/procurement-routes.test.ts`

Expected: PASS。

- [x] **Step 2: 运行全量类型检查与测试**

Run: `pnpm typecheck`

Expected: PASS。

Run: `pnpm test`

Expected: PASS。

- [x] **Step 3: 重启受影响的真实服务**

确认 3001、4173、4174 健康，Temporal Worker 的运行时仍为真实 DSH。

- [ ] **Step 4: 发送结构化真实 PO 邮件并接收回复**

通过现有 Outbox 发送到已授权的真实供应商测试邮箱，正文要求回复明确境内路线、确认、生产完成数量与百分比、ASN、承运商、运单和 ETA。保存 SMTP Message-ID 与回执。

- [ ] **Step 5: 验证自动更新**

IMAP 收到回复后，检查 `Communication`、AI 分析、路线 assignment、confirmation、production_progress、shipment、阶段事件和前端页面一致，来源均准确。

- [ ] **Step 6: 等待并验证真实 GRN**

只有 Odoo/WMS 将对应入库单状态真实完成后才回读 Receipt/GRN；确认五阶段闭环和上线就绪度达到 11/11。若入库单未完成，保持目标活动并报告这一外部事实，不生成替代记录。
