# Hermes-Inspired Messaging Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Email 的真实出站与入站路径迁移到 Readywork 原生消息网关，建立通用适配器、可靠投递、持久化入站、健康/熔断和清晰采购桥接边界。

**Architecture:** 保留 `procurement_outbox` 作为审批后的领域命令，在其与 SMTP 之间加入通用 `MessageGateway` 投递账本；IMAP 先写通用入站表，再通过 `ProcurementMessagingBridge` 生成采购 Communication 和 AI 事实。消息网关只处理渠道 I/O 与运行状态，采购领域继续独占 PO、审批、路线、生产、发运和 GRN。

**Tech Stack:** TypeScript 6、Node.js 24、`node:sqlite`、Next.js 16.3.3、React 19、现有 SMTP/IMAP/Connector Control Plane、DeepSeek、Temporal。

**Spec:** `docs/superpowers/specs/2026-09-08-hermes-inspired-messaging-gateway-boundaries-design.md`

## Global Constraints

- 不安装或运行 Hermes；只吸收其单网关、多适配器、健康、暂停、熔断和可靠投递思想。
- 不使用 Mock、内存数据库、假 Message-ID、假供应商回复、假路线、假 Shipment、假 Receipt 或假 GRN 验收正式路径。
- `procurement_outbox` 继续是领域命令权威；`messaging_deliveries` 只负责渠道 I/O 权威。
- DeepSeek 每个可应用字段必须保留当前回复逐字原文引用，来源仍为 `supplier_email_ai`。
- SMTP 结果不确定时标记 `unknown`，禁止自动重复发送。
- IMAP 入站必须先持久化到网关表，再派发到采购桥接器。
- Odoo/WMS 继续是最终 Delivery / GRN 的唯一权威来源。
- 正式 readiness 不因代码、测试或网关迁移自动变为 11/11。
- 当前目录不是 Git 仓库；每个任务以变更清单和验证结果作为检查点，不执行 commit。
- 修改 `apps/console` 前必须读取 `apps/console/AGENTS.md` 与 `apps/console/node_modules/next/dist/docs/` 中与客户端数据获取和路由相关的当前版本文档。

---

### Task 1: 建立通用消息合同与 Migration 53

**Files:**
- Create: `packages/messaging/package.json`
- Create: `packages/messaging/src/contracts.ts`
- Create: `packages/messaging/src/repository.ts`
- Create: `packages/messaging/src/index.ts`
- Create: `packages/messaging/test/repository.test.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `packages/persistence/test/procurement-persistence.test.ts`
- Modify: `tsconfig.json`
- Modify: `apps/api/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `MessagingChannel`, `InboundMessageEnvelope`, `MessageDeliveryRequest`, `MessageDeliveryReceipt`, `MessagingAdapterState`, `MessagingRepository`。
- Produces: Migration 53 的 `messaging_inbound_messages`、`messaging_deliveries`、`messaging_adapter_states`、`messaging_gateway_events`、`messaging_gateway_actions`。
- Consumes: `DatabaseSync` 和现有 `runMigrations()`。

- [x] **Step 1: 写 Migration 53 失败测试**

在 `packages/persistence/test/procurement-persistence.test.ts` 增加测试，断言迁移后四张表、唯一键、CHECK 约束和索引存在：

```ts
test('migration 53 installs tenant-scoped messaging gateway tables', () => {
  const store = new SqliteStore(':memory:');
  for (const table of ['messaging_inbound_messages', 'messaging_deliveries', 'messaging_adapter_states', 'messaging_gateway_events', 'messaging_gateway_actions']) {
    assert.ok(store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table));
  }
  assert.throws(() => store.db.prepare(`INSERT INTO messaging_deliveries
    (tenant_id,id,adapter_id,channel,idempotency_key,status,request_json,attempts,created_at,updated_at)
    VALUES ('t:1','d:1','email','email','k:1','invented','{}',0,'2026-09-08T00:00:00.000Z','2026-09-08T00:00:00.000Z')`).run());
});
```

- [x] **Step 2: 运行迁移测试并确认失败**

Run: `pnpm exec tsx --test packages/persistence/test/procurement-persistence.test.ts`

Expected: FAIL，原因是 `messaging_deliveries` 尚不存在。

- [x] **Step 3: 定义 Migration 53**

在 `packages/persistence/src/index.ts` 新增 `MESSAGING_GATEWAY_SCHEMA`，使用以下状态约束：

```sql
CHECK (status IN ('pending','sending','accepted','retry_wait','unknown','failed','abandoned'))
CHECK (status IN ('received','dispatching','processed','rejected','failed'))
CHECK (status IN ('running','degraded','paused','paused_by_breaker','disabled','unconfigured'))
```

并在 `runMigrations()` 末尾注册：

```ts
{ version: 53, name: 'messaging-gateway-boundaries', sql: MESSAGING_GATEWAY_SCHEMA }
```

- [x] **Step 4: 写仓储失败测试**

覆盖：相同入站提供商消息幂等、相同投递幂等键重放、不同请求指纹冲突、状态版本递增、事件不保存消息正文。

```ts
const first = repository.receive(envelope);
const replay = repository.receive(envelope);
assert.equal(first.replayed, false);
assert.equal(replay.replayed, true);
assert.equal(repository.listInbound({ status: 'received' }).length, 1);
```

- [x] **Step 5: 运行仓储测试并确认失败**

Run: `pnpm exec tsx --test packages/messaging/test/repository.test.ts`

Expected: FAIL，原因是 `@readywork/messaging` 尚不存在。

- [x] **Step 6: 实现通用合同与 `MessagingRepository`**

`contracts.ts` 使用规格中的精确字段；`repository.ts` 提供：

```ts
export class MessagingRepository {
  receive(envelope: InboundMessageEnvelope): { message: StoredInboundMessage; replayed: boolean };
  reserveDelivery(request: MessageDeliveryRequest, at: string): { delivery: StoredDelivery; owner: boolean; replayed: boolean };
  markDeliverySending(id: string, expectedVersion: number, at: string): StoredDelivery;
  completeDelivery(id: string, expectedVersion: number, receipt: AdapterSendResult, at: string): StoredDelivery;
  failDelivery(id: string, expectedVersion: number, failure: AdapterFailure, at: string): StoredDelivery;
  claimInbound(limit: number, workerId: string, leaseMs: number, at: string): StoredInboundMessage[];
  completeInbound(id: string, status: 'processed' | 'rejected', at: string, outcomeCode: string): StoredInboundMessage;
  failInbound(id: string, at: string, error: string): StoredInboundMessage;
  getAdapterState(adapterId: string): MessagingAdapterState | undefined;
  saveAdapterState(state: MessagingAdapterState, expectedVersion?: number): MessagingAdapterState;
  appendEvent(event: MessagingGatewayEvent): void;
}
```

`contracts.ts` 同时定义以下适配器结果，不允许使用布尔值掩盖外部调用是否已经开始：

```ts
export type AdapterSendResult =
  | { kind: 'accepted'; providerMessageId: string; acceptedAt: string }
  | { kind: 'retryable_before_dispatch'; error: string }
  | { kind: 'failed_before_dispatch'; error: string }
  | { kind: 'unknown_after_dispatch'; error: string };

export type AdapterFailure = Exclude<AdapterSendResult, { kind: 'accepted' }>;
```

所有请求以规范 JSON 的 SHA-256 指纹检测同键不同载荷；所有错误通过调用者传入的已脱敏字符串落库。

- [x] **Step 7: 注册工作区包并更新锁文件**

在 `tsconfig.json` 增加：

```json
"@readywork/messaging": ["packages/messaging/src/index.ts"]
```

在 `apps/api/package.json` 增加 workspace 依赖，并运行 `pnpm install --lockfile-only` 更新 `pnpm-lock.yaml`。

- [x] **Step 8: 运行 Task 1 验证**

Run: `pnpm exec tsx --test packages/messaging/test/repository.test.ts packages/persistence/test/procurement-persistence.test.ts`

Expected: PASS。

Run: `pnpm typecheck`

Expected: exit 0。

---

### Task 2: 实现网关内核、能力检查与熔断状态机

**Files:**
- Create: `packages/messaging/src/gateway.ts`
- Create: `packages/messaging/src/circuit-breaker.ts`
- Create: `packages/messaging/test/gateway.test.ts`
- Modify: `packages/messaging/src/contracts.ts`
- Modify: `packages/messaging/src/index.ts`

**Interfaces:**
- Consumes: Task 1 的 `MessagingRepository` 与通用合同。
- Produces: `MessagingAdapter`、`MessageGateway.deliver()`、`MessageGateway.ingest()`、`MessageGateway.pauseAdapter()`、`MessageGateway.resumeAdapter()`、`MessageGateway.health()`。

- [x] **Step 1: 写投递幂等与诚实结果测试**

```ts
test('accepted delivery is replayed without invoking adapter twice', async () => {
  let calls = 0;
  const adapter = adapterFixture({ send: async () => ({ kind: 'accepted', providerMessageId: '<m1@example.test>', acceptedAt: now }) });
  adapter.send = async (request) => { calls++; return { kind: 'accepted', providerMessageId: '<m1@example.test>', acceptedAt: now }; };
  const first = await gateway.deliver(requestFixture());
  const replay = await gateway.deliver(requestFixture());
  assert.equal(first.status, 'accepted');
  assert.equal(replay.replayed, true);
  assert.equal(calls, 1);
});
```

另测 `unknown` 不重发、缺少附件能力被调用前拒绝、不同渠道适配器互不影响。

- [x] **Step 2: 运行网关测试并确认失败**

Run: `pnpm exec tsx --test packages/messaging/test/gateway.test.ts`

Expected: FAIL，原因是 `MessageGateway` 尚不存在。

- [x] **Step 3: 实现适配器合同与 `deliver()`**

```ts
export interface MessagingAdapter {
  readonly id: string;
  readonly channel: MessagingChannel;
  readonly provider: string;
  readonly capabilities: readonly MessagingCapability[];
  health(): Promise<AdapterHealth>;
  send(request: MessageDeliveryRequest): Promise<AdapterSendResult>;
  close?(): Promise<void>;
}
```

`deliver()` 必须先 reserve，再验证状态/能力，再标记 sending，再调用 adapter，最后原子保存 `accepted | unknown | failed`。`accepted` 和 `unknown` 的重放不再次调用适配器。

- [x] **Step 4: 写熔断失败测试**

连续三个 `retryable_before_dispatch` 失败后断言：

```ts
assert.equal(gateway.getAdapterState('email').status, 'paused_by_breaker');
await assert.rejects(() => gateway.deliver(nextRequest), /适配器已熔断/);
```

同时断言一次成功清零失败计数，管理员恢复要求匹配版本且写 `adapter_resumed` 事件。

- [x] **Step 5: 实现熔断状态机**

`recordAdapterSuccess()` 清零连续失败；`recordAdapterFailure()` 只统计五分钟窗口内的可重试故障，第 3 次切换为 `paused_by_breaker`。`paused` 和 `paused_by_breaker` 都阻止新外部 I/O，但不修改领域 Outbox。

- [x] **Step 6: 实现持久化入站 `ingest()`**

```ts
async ingest(envelope: InboundMessageEnvelope): Promise<{ inboundId: string; replayed: boolean }> {
  const stored = this.repository.receive(envelope);
  this.repository.appendEvent(receivedEvent(stored.message, stored.replayed));
  return { inboundId: stored.message.id, replayed: stored.replayed };
}
```

此方法只持久化，不调用采购代码。

- [x] **Step 7: 运行 Task 2 验证**

Run: `pnpm exec tsx --test packages/messaging/test/gateway.test.ts packages/messaging/test/repository.test.ts`

Expected: PASS。

Run: `pnpm typecheck`

Expected: exit 0。

---

### Task 3: 将真实 SMTP 出站接入网关

**Files:**
- Create: `apps/api/src/messaging/email-adapter.ts`
- Create: `apps/api/src/messaging/runtime.ts`
- Create: `apps/api/test/messaging-email-adapter.test.ts`
- Modify: `apps/api/src/procurement-outbox-worker.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/test/procurement-outbox-worker.test.ts`
- Modify: `packages/connectors/src/smtp.ts`

**Interfaces:**
- Consumes: `MessageGateway` 与现有 Email Connector/凭据控制面。
- Produces: `EmailMessagingAdapter` 和租户级 `MessagingRuntime`。
- Changes: Email/WhatsApp 的采购 Outbox 通过 `MessageGateway.deliver()`，ERP 继续走原连接器路径。

- [x] **Step 1: 写 Email Adapter 映射测试**

使用捕获型测试发送器而非网络，断言 `to/fromName/subject/body/attachments/messageId/inReplyTo/references` 无损映射，真实发送结果转为：

```ts
{
  kind: 'accepted',
  providerMessageId: result.messageId,
  acceptedAt: result.acceptedAt,
}
```

连接错误发生在 SMTP DATA 前映射为 `retryable_before_dispatch`；DATA 已写出但缺少最终应答映射为 `unknown_after_dispatch`。

- [x] **Step 2: 运行适配器测试并确认失败**

Run: `pnpm exec tsx --test apps/api/test/messaging-email-adapter.test.ts`

Expected: FAIL，原因是 `EmailMessagingAdapter` 尚不存在。

- [x] **Step 3: 让 SMTP 返回明确的外部调用阶段**

在 `packages/connectors/src/smtp.ts` 内部跟踪 `dataStarted` 与最终 `250` 接受状态，不改变成功调用现有字段；错误对象增加只读 `dispatchStage: 'before_dispatch' | 'after_dispatch'`，不在消息中暴露凭据。

- [x] **Step 4: 实现 `EmailMessagingAdapter`**

适配器只依赖一个已经解析的发送函数：

```ts
export class EmailMessagingAdapter implements MessagingAdapter {
  readonly channel = 'email' as const;
  readonly capabilities = ['send_text', 'send_attachments', 'threads'] as const;
  constructor(readonly id: string, readonly provider: string, private readonly sendMail: EmailSendPort) {}
  health(): Promise<AdapterHealth>;
  send(request: MessageDeliveryRequest): Promise<AdapterSendResult>;
}
```

- [x] **Step 5: 写采购 Outbox 网关边界失败测试**

新增测试断言 Email 消息只调用 `messageGateway.deliver()`，不再直接调用 `connectors.execute()`；ERP 消息仍调用原路径。网关返回 `unknown` 时采购 Outbox 进入 `unknown`/人工核对状态，不得重试或 complete。

- [x] **Step 6: 修改 `ProcurementOutboxWorker`**

构造器新增：

```ts
messageGatewayForTenant?: (tenantId: string) => MessageDeliveryPort;
```

当 `message.channel` 为 `email` 或 `whatsapp` 时，使用冻结附件构造 `MessageDeliveryRequest`，其中：

```ts
trace: { source: 'procurement_outbox', sourceId: message.id, correlationId: message.aggregateId }
```

网关 `accepted` 映射回现有 `connectorResult.message_id/accepted_at/delivery_status`，保持投影兼容。

- [x] **Step 7: 组合真实运行时**

`messaging/runtime.ts` 从租户 Connector Control Plane 解析已验证 Email 凭据，注册一个 `email` 适配器并把同一个网关实例同时提供给 Outbox Worker 和后续 IMAP 入站。`index.ts` 不再直接为 Email Outbox 调用通用 ConnectorRegistry。

- [x] **Step 8: 运行 Task 3 验证**

Run: `pnpm exec tsx --test apps/api/test/messaging-email-adapter.test.ts apps/api/test/procurement-outbox-worker.test.ts packages/connectors/test/smtp.test.ts`

Expected: PASS。

Run: `pnpm typecheck`

Expected: exit 0。

---

### Task 4: 将 IMAP 入站改为“先网关持久化、后采购桥接”

**Files:**
- Create: `apps/api/src/messaging/procurement-bridge.ts`
- Create: `apps/api/test/messaging-procurement-bridge.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/procurement-inbound-email.ts`
- Modify: `apps/api/src/procurement-inbound-mail-monitor.ts`
- Modify: `packages/connectors/src/mail-router.ts`
- Modify: `packages/connectors/test/mail-router.test.ts`
- Modify: `apps/api/test/procurement-inbound-email.test.ts`

**Interfaces:**
- Consumes: `InboundMessageEnvelope`、`MessageGateway.ingest()`、现有 `handleProcurementInboundEmail()` 与 DeepSeek 自动应用服务。
- Produces: `ProcurementMessagingBridge.handle(storedInbound)`，返回 `processed | rejected | retryable_failure`。

- [x] **Step 1: 写入站顺序失败测试**

用临时 SQLite 和真实处理函数断言顺序：

```ts
await pollInboundMail(imap, gatewayHandler);
assert.equal(queryCount(db, 'messaging_inbound_messages'), 1);
assert.equal(queryCount(db, 'procurement_documents', "kind='communication'"), 1);
```

让桥接器在持久化后抛错，断言网关入站行仍存在且状态为 `failed`，第二次重放不新增行。

- [x] **Step 2: 运行入站测试并确认失败**

Run: `pnpm exec tsx --test apps/api/test/messaging-procurement-bridge.test.ts packages/connectors/test/mail-router.test.ts`

Expected: FAIL，因为轮询仍直接调用采购处理器。

- [x] **Step 3: 实现 Email 信封规范化**

把 `InboundEmail` 转换为 `InboundMessageEnvelope`，稳定 ID 使用以下组成的 SHA-256：

```ts
`${tenantId}\0email\0${adapterId}\0${messageId ?? `${mailbox}:${uid}`}`
```

`rawFingerprint` 覆盖规范化发件人、主题、当前正文、附件哈希和时间，不保存 IMAP 密码或原始会话。

- [x] **Step 4: 实现 `ProcurementMessagingBridge`**

桥接器把信封转回采购入站输入，复用已有供应商身份校验、PO 线程解析、拒绝审计、Communication 幂等和 DeepSeek 自动应用。桥接器的返回值必须区分：

```ts
type ProcurementBridgeResult =
  | { status: 'processed'; communicationId: string }
  | { status: 'rejected'; reasonCode: string }
  | { status: 'retryable_failure'; error: string };
```

- [x] **Step 5: 修改 IMAP 轮询边界**

`index.ts` 中每封邮件执行：`normalize → gateway.ingest → bridge.handle → gateway complete/fail`。一旦网关入站持久化成功，即使桥接暂时失败也可以安全标记 IMAP 已读，因为后续从 `messaging_inbound_messages` 重放；未持久化前仍禁止标记已读。

- [x] **Step 6: 增加入站恢复 Worker**

`MessagingRuntime.runPendingInbound()` 领取 `received/failed` 的超时行并重新派发桥接器。使用租约避免 API 重启或并发轮询重复处理，同一 `providerMessageId` 只产生一条 Communication。

- [x] **Step 7: 保持 DeepSeek 证据合同**

运行现有 AI 回信测试，确认路线、承诺、生产和 Shipment 的逐字引用、部分成功与幂等顺序均未变化。

- [x] **Step 8: 运行 Task 4 验证**

Run: `pnpm exec tsx --test apps/api/test/messaging-procurement-bridge.test.ts apps/api/test/procurement-inbound-email.test.ts apps/api/test/procurement-ai-reply.test.ts packages/connectors/test/mail-router.test.ts packages/connectors/test/imap-parser.test.ts`

Expected: PASS。

Run: `pnpm typecheck`

Expected: exit 0。

---

### Task 5: 增加网关运维 API、权限、暂停与恢复

**Files:**
- Create: `apps/api/src/messaging-routes.ts`
- Create: `apps/api/test/messaging-routes.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/auth.ts`
- Modify: `apps/api/src/http-errors.ts`

**Interfaces:**
- Consumes: Task 2/3 的租户级 `MessagingRuntime`。
- Produces: `GET /api/messaging/gateway`、`POST /api/messaging/adapters/:id/pause`、`POST /api/messaging/adapters/:id/resume`、`GET /api/messaging/deliveries`。

- [x] **Step 1: 写 HTTP 权限和合同失败测试**

覆盖 401 未登录、403 非管理员写、跨租户隔离、缺幂等键 400、陈旧版本 409、重复请求同响应、响应不含凭据/正文/完整邮箱地址。

```ts
const response = await request('POST', '/api/messaging/adapters/email/pause', {
  cookie: adminCookie,
  headers: { 'Idempotency-Key': 'pause-email-1' },
  body: { expectedVersion: 1, reason: '服务商维护' },
});
assert.equal(response.status, 200);
assert.equal(response.body.adapter.status, 'paused');
```

- [x] **Step 2: 运行路由测试并确认失败**

Run: `pnpm exec tsx --test apps/api/test/messaging-routes.test.ts`

Expected: FAIL，原因是路由尚不存在。

- [x] **Step 3: 实现只读摘要**

返回：

```ts
{
  status: 'running' | 'degraded' | 'blocked',
  checkedAt: string,
  adapters: Array<{
    id: string; channel: MessagingChannel; provider: string;
    status: MessagingAdapterStatus; capabilities: MessagingCapability[];
    version: number; consecutiveFailures: number;
    lastHealthAt: string | null; lastError: string | null;
    pendingInbound: number; pendingDeliveries: number; exceptionalDeliveries: number;
  }>
}
```

不返回请求正文、附件、凭据 ID 或完整收件人。

- [x] **Step 4: 实现暂停/恢复幂等写**

使用 Task 1 的 `messaging_gateway_actions` 表保存请求指纹和响应。暂停/恢复必须写 `messaging_gateway_events`，版本每次递增。

- [x] **Step 5: 实现异常投递只读列表**

只允许 `unknown|failed|abandoned`，返回 delivery ID、渠道、状态、尝试、时间、遮罩收件人、来源类型/ID和脱敏错误，不返回正文。

- [x] **Step 6: 运行 Task 5 验证**

Run: `pnpm exec tsx --test apps/api/test/messaging-routes.test.ts apps/api/test/auth.test.ts`

Expected: PASS。

Run: `pnpm typecheck`

Expected: exit 0。

---

### Task 6: Configuration 使用真实网关状态

**Files:**
- Create: `apps/console/features/procurement/messaging-gateway-panel.tsx`
- Create: `apps/console/test/messaging-gateway-panel-interaction.test.tsx`
- Modify: `apps/console/features/procurement/configuration-workbench.tsx`
- Modify: `apps/console/test/configuration-workbench-interaction.test.tsx`

**Interfaces:**
- Consumes: Task 5 的四个控制面 API。
- Produces: 通信连接区域的真实网关状态、失败详情、暂停/恢复操作和刷新后持久化状态。

- [ ] **Step 1: 读取 Next.js 16.3.3 当前文档**

Run: `sed -n '1,240p' apps/console/node_modules/next/dist/docs/01-app/01-getting-started/09-fetching-data.md`

若路径不存在，先用 `rg --files apps/console/node_modules/next/dist/docs | rg 'fetch|client|route'` 定位对应当前版本文档并完整读取相关文件。

- [ ] **Step 2: 写交互失败测试**

覆盖加载、空态、API 错误、running/degraded/paused/paused_by_breaker/unconfigured、管理员暂停确认、恢复版本冲突和成功后重新读取。

```tsx
render(<MessagingGatewayPanel manageable initial={gatewayFixture('paused_by_breaker')} />);
assert.match(screen.getByText('已熔断').textContent ?? '', /已熔断/);
await user.click(screen.getByRole('button', { name: '恢复邮件适配器' }));
assert.equal(mutations[0]?.expectedVersion, 3);
```

- [ ] **Step 3: 运行前端测试并确认失败**

Run: `pnpm --dir apps/console exec tsx --test test/messaging-gateway-panel-interaction.test.tsx`

Expected: FAIL，原因是组件尚不存在。

- [ ] **Step 4: 实现网关面板**

复用现有 `apiRequest`、Badge、Card 和权限文案。状态文案固定为：`运行中 / 性能下降 / 已暂停 / 已熔断 / 已禁用 / 未配置`。暂停/恢复对话框要求非空原因，pending 时锁定关闭，成功后重新 GET。

- [ ] **Step 5: 接入 Configuration**

现有 Credential 卡继续显示凭据和外部验证；网关面板显示运行事实。两者不能相互推断：凭据“已验证”不等于适配器“运行中”，适配器“运行中”也不暴露凭据。

- [ ] **Step 6: 运行 Task 6 验证**

Run: `pnpm --dir apps/console exec tsx --test test/messaging-gateway-panel-interaction.test.tsx test/configuration-workbench-interaction.test.tsx`

Expected: PASS。

Run: `pnpm --dir apps/console exec tsc --noEmit`

Expected: exit 0。

Run: `pnpm --dir apps/console build`

Expected: exit 0。

---

### Task 7: 真实运行栈切换与无重复发送验证

**Files:**
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/procurement-v1-readiness.ts`
- Modify: `docs/NAVISIGHT-V1-ALIGNMENT.md`
- Test: `apps/api/test/operations-v1-readiness-integration.test.ts`
- Test: `apps/api/test/messaging-runtime-integration.test.ts`

**Interfaces:**
- Consumes: Task 1–6 的完整 Email 网关路径。
- Produces: 正式 SQLite Migration 53、运行中的 Email Adapter、无重复的历史 Outbox、真实网关状态和不变的 11 项业务门槛语义。

- [ ] **Step 1: 写运行时切换集成测试**

使用临时文件 SQLite 启动 Business/Control API，断言：重启前后 accepted delivery 不重发；处理中入站租约超时后恢复；熔断只阻断消息适配器；`/api/operations/v1-readiness` 仍只计算原 11 项业务证据。

- [ ] **Step 2: 运行集成测试并确认失败**

Run: `pnpm exec tsx --test apps/api/test/messaging-runtime-integration.test.ts apps/api/test/operations-v1-readiness-integration.test.ts`

Expected: FAIL，直到所有运行时组合完成。

- [ ] **Step 3: 精确停止并重启四项真实服务**

使用现有运行会话结束 Console、Business API、Control API 和 Temporal Worker；保持 Docker Temporal 集群。重新启动时继续使用真实 `data/readywork.sqlite`、真实凭据控制面和 DSH，禁止 `MEMORY=1` 或 inmemory agent。

- [ ] **Step 4: 迁移前记录不可变基线**

只读记录：

```sql
SELECT COUNT(*) FROM procurement_outbox WHERE status='dispatched';
SELECT id,status,attempts,json_extract(json,'$.connectorResult.message_id')
FROM procurement_outbox ORDER BY created_at;
SELECT COUNT(*) FROM procurement_documents WHERE kind='communication';
```

同时记录 P00021 的版本、路线、五阶段事件、Confirmation、Production Progress、Shipment、Receipt 与 Odoo 入库单状态。

- [ ] **Step 5: 启动后验证 Migration 53 与网关健康**

通过登录后的 `GET /api/messaging/gateway` 断言 Email 为 `running`，数据库版本为 53，待处理/异常投递为真实数值。再次读取历史 Outbox，数量、状态、尝试次数和 Message-ID 必须与基线一致。

- [ ] **Step 6: 运行全量工程验证**

Run: `pnpm test`

Expected: 所有测试 PASS。

Run: `pnpm typecheck`

Expected: exit 0。

Run: `pnpm --dir apps/console build`

Expected: exit 0。

- [ ] **Step 7: 浏览器验证 Configuration 与 P00021**

使用已登录 Chrome：Configuration 显示真实 Email 网关运行状态；P00021 历史邮件和 Outbox 回执不重复；浏览器 Console 无 error/warning；刷新后状态保持。

- [ ] **Step 8: 真实邮件纵切验证**

只能通过已有草稿审批与采购 Outbox 创建一封结构化 P00021 邮件。验证链路：

```text
procurement_message_drafts
→ procurement_outbox
→ messaging_deliveries(accepted + provider Message-ID)
→ SMTP
→ 供应商真实回复
→ messaging_inbound_messages
→ Communication
→ DeepSeek 逐字引用
→ 采购命令与页面刷新
```

如果当前已有同目的邮件等待回复，禁止再发送重复邮件；先人工触发一次 IMAP 检查并等待真实回复。

- [ ] **Step 9: 更新实施证据**

在 `docs/NAVISIGHT-V1-ALIGNMENT.md` 记录实际迁移版本、测试计数、运行探针、真实 Message-ID/入站 ID 的脱敏引用、P00021 状态和 readiness。不得将网关完成写成 11/11，除非真实路线与 Odoo/WMS GRN 已同时满足。

---

### Task 8: 继续 P00021 的真实五阶段闭环

**Files:**
- No source file required unless真实验证暴露缺陷；任何修复回到对应任务的 TDD 流程。
- Evidence: `data/readywork.sqlite`、Odoo API、运行中控制面/业务面 API、登录态 Console。

**Interfaces:**
- Consumes: 已切换的 Email 消息网关、采购桥接器、DeepSeek、现有路线/Confirmation/Production/Shipment/Receipt 命令和 Odoo 回读。
- Produces: 原目标要求的真实本地采购订单与五阶段闭环证据。

- [ ] **Step 1: 接收并核验供应商真实回复**

回复必须在当前回复正文中明确：本订单为境内/本地采购；每行数量、单价、币种和承诺交期；已完成数量与百分比；ASN、承运商、运单号和 ETA。AI 只应用有逐字引用的字段。

- [ ] **Step 2: 核对网关与采购投影一致**

断言网关入站、Communication、AI 分析、路线分配、Confirmation、Production Progress、Shipment、阶段事件和前端显示引用同一真实 Message-ID，且无重复记录。

- [ ] **Step 3: 读取真实 Odoo 入库单**

重新读取 P00021 对应入库单；只有 Odoo/WMS 返回真实完成状态、完成数量和完成日期时，才创建/更新 Receipt 与 `odoo_grn` / `wms_grn` 证据。禁止人工把入库单标完成。

- [ ] **Step 4: 最终 11 项完成审计**

登录后读取 `GET /api/operations/v1-readiness`，逐项核验 `readyGates=11`、`totalGates=11`、P00021 为 local、五阶段均有非迁移精确完成事件、最终 GRN 来源为 Odoo/WMS。若任何一项缺证据，保持 goal active，不宣称完成。
