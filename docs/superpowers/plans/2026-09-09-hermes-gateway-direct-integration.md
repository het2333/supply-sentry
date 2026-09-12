# Hermes Gateway 官方组件直接集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 运行固定版本 Hermes Gateway Sidecar，把官方支持的全部动态消息渠道通过双向 HMAC Bridge 接入 Readywork 的 Inbox、Outbox、审批、AI 分析和中文设置页。

**Architecture:** Hermes v2026.9.7 是渠道目录、配置、onboarding 和协议投递的权威源；Readywork 是租户、Inbox/Outbox、幂等、采购状态和审批的唯一权威源。Node API 代理 Hermes 管理面；受认证的 Weixin onboarding 侧车复用 Hermes 原生 iLink 扫码实现；Python readywork_bridge 插件在 pre_gateway_dispatch 持久化入站 spool 并阻止通用 Agent，内部 Platform Adapter 在同一 Gateway 进程中调用官方适配器出站。

**Tech Stack:** TypeScript 6、Node.js 22 node:http/node:sqlite、Next.js 16、React 19、Python 3.11+、Docker Compose、HMAC-SHA256。

**Spec:** docs/superpowers/specs/2026-09-09-hermes-gateway-direct-integration-design.md

## Global Constraints

- Hermes Agent 固定为官方镜像 v2026.9.7，镜像摘要固定为 sha256:63bfb6d732f49a55d453e801057273785cc61e0f6ee43db3fa2f2a79846301b7，源码提交固定为 2237be355906fbe6065ce1815711eee52b2d646e。
- 不修改 Hermes 核心源码，仅使用 Sidecar、官方动态目录和 Readywork Bridge Plugin。
- 渠道集合不在 TypeScript 或前端写固定枚举，唯一目录是运行中 Hermes /api/messaging/platforms。
- 密钥、凭据、服务令牌、Hermes 文件路径不进入源码、日志或浏览器响应。
- 入站先持久化 spool；Readywork 事务持久化后才确认。出站结果不明映射 unknown_after_dispatch 且禁止自动重发。
- Email 只允许 native 或 hermes 单路模式，不允许 both。
- 无第三方真实凭据时只显示可配置或未配置，不伪造已连接。
- 前端产品文案全部中文，品牌名和协议名保留原文。
- 当前工作区不是 Git 仓库；不执行 commit，以红绿测试、构建和健康探针验收。

---

### Task 1: 动态渠道合同与 Migration 55

**Files:**
- Modify: packages/messaging/src/contracts.ts
- Modify: packages/persistence/src/index.ts
- Modify: packages/persistence/test/messaging-gateway-migration.test.ts
- Test: packages/messaging/test/repository.test.ts

**Interfaces:**
- Produces: MessagingChannel = string，以及 isValidMessagingChannel(value: unknown)。
- Produces: migration 55，把三张 messaging 表的 channel 约束改为 1–96 位安全标识。

- [ ] **Step 1: Write the failing test**
  插入 telegram、wecom_callback、future-platform:v2 应成功；空值、空白、路径穿越和超长值应触发 CHECK。
- [ ] **Step 2: Run test to verify it fails**
  Run: pnpm exec tsx --test packages/persistence/test/messaging-gateway-migration.test.ts
  Expected: telegram 被旧固定枚举拒绝。
- [ ] **Step 3: Write minimal implementation**
  使用新表、复制数据、删除旧表、重命名、恢复索引的单事务 migration，并保留 migration 54 附件外键。
- [ ] **Step 4: Run test to verify it passes**
  Run: pnpm exec tsx --test packages/persistence/test/messaging-gateway-migration.test.ts packages/messaging/test/repository.test.ts
  Expected: PASS。

### Task 2: Hermes 持久化仓库

**Files:**
- Modify: packages/persistence/src/index.ts
- Create: apps/api/src/messaging/hermes-repository.ts
- Create: apps/api/test/hermes-repository.test.ts

**Interfaces:**
- Produces: HermesRepository.profileForTenant、savePlatformSnapshot、latestPlatformSnapshot、consumeNonce、recordBridgeReceipt、recordPlatformAction。
- Produces: migration 56 的 hermes_tenant_profiles、hermes_platform_snapshots、hermes_bridge_nonces、hermes_bridge_receipts、hermes_platform_actions。

- [ ] **Step 1: Write the failing test**
  验证 profile 稳定且跨租户不冲突、snapshot 隔离、nonce 只消费一次、action 不保存明文凭据。
- [ ] **Step 2: Run test to verify it fails**
  Run: pnpm exec tsx --test apps/api/test/hermes-repository.test.ts
  Expected: 模块或数据表不存在。
- [ ] **Step 3: Write minimal implementation**
  profile 为 rw- 加 tenant SHA-256 前 24 位；nonce 在 BEGIN IMMEDIATE 中清理过期值并插入。
- [ ] **Step 4: Run test to verify it passes**
  Run: pnpm exec tsx --test apps/api/test/hermes-repository.test.ts
  Expected: PASS。

### Task 3: Hermes Control Client 与动态目录

**Files:**
- Create: apps/api/src/messaging/hermes-control-client.ts
- Create: apps/api/test/hermes-control-client.test.ts

**Interfaces:**
- Produces: platforms、configurePlatform、testPlatform、onboarding、health。
- Produces: HermesPlatformCatalog 和 HermesUpstreamError。

- [ ] **Step 1: Write the failing test**
  本地 HTTP 上游验证服务端 profile、凭据脱敏、401 只刷新一次、超时、1 MiB 响应限制、JSON 形状校验。
- [ ] **Step 2: Run test to verify it fails**
  Run: pnpm exec tsx --test apps/api/test/hermes-control-client.test.ts
  Expected: client 模块不存在。
- [ ] **Step 3: Write minimal implementation**
  注入 fetch、baseUrl、serviceToken、timeoutMs，只代理固定白名单路径，过滤 readywork_bridge 内部平台；首次读取时幂等创建缺失的 Readywork 租户隔离 profile。
- [ ] **Step 4: Run test to verify it passes**
  Run: pnpm exec tsx --test apps/api/test/hermes-control-client.test.ts
  Expected: PASS。

### Task 4: HMAC Bridge 合同与入站落库

**Files:**
- Create: apps/api/src/messaging/hermes-bridge.ts
- Create: apps/api/test/hermes-bridge.test.ts
- Modify: apps/api/src/index.ts

**Interfaces:**
- Produces: verifyHermesBridgeRequest，POST /api/integrations/hermes/v1/inbound。
- Returns: persisted、inboundId、replayed。

- [ ] **Step 1: Write the failing test**
  手算 HMAC 字面量验证正确请求落入真实 Inbox；错版本、错签名、超过 300 秒、nonce 重放、profile 不匹配全部拒绝。
- [ ] **Step 2: Run test to verify it fails**
  Run: pnpm exec tsx --test apps/api/test/hermes-bridge.test.ts
  Expected: verifier 或 route 不存在。
- [ ] **Step 3: Write minimal implementation**
  签名串为 METHOD、PATH、TIMESTAMP、NONCE、RAW_BODY 五行，timingSafeEqual 校验；通过 MessageGateway.ingest 事务落库。
- [ ] **Step 4: Run test to verify it passes**
  Run: pnpm exec tsx --test apps/api/test/hermes-bridge.test.ts apps/api/test/messaging-procurement-bridge.test.ts
  Expected: PASS。

### Task 5: Readywork 平台管理 API

**Files:**
- Create: apps/api/src/messaging/hermes-routes.ts
- Create: apps/api/test/hermes-routes.test.ts
- Modify: apps/api/src/index.ts

**Interfaces:**
- Produces: GET /api/messaging/platforms，PUT /api/messaging/platforms/:id，POST /api/messaging/platforms/:id/test，onboarding 白名单路由，GET /api/messaging/hermes/health。
- Consumes: HermesControlClient、HermesRepository、Session/can 权限模型。

- [ ] **Step 1: Write the failing test**
  验证未登录 401、非管理员 mutation 403、动态未知渠道可读、字段白名单、敏感值不回填、幂等重放/冲突、过期快照禁用 mutation。
- [ ] **Step 2: Run test to verify it fails**
  Run: pnpm exec tsx --test apps/api/test/hermes-routes.test.ts
  Expected: route 未注册。
- [ ] **Step 3: Write minimal implementation**
  只接受目录声明的 platform id 和 env field，输出统一中文状态；上游不可达时只返回 stale 为 true 的最后快照。
- [ ] **Step 4: Run test to verify it passes**
  Run: pnpm exec tsx --test apps/api/test/hermes-routes.test.ts apps/api/test/messaging-routes.test.ts
  Expected: PASS。

### Task 6: Hermes readywork_bridge Python Plugin

**Files:**
- Create: infra/hermes/plugins/readywork_bridge/plugin.yaml
- Create: infra/hermes/plugins/readywork_bridge/__init__.py
- Create: infra/hermes/plugins/readywork_bridge/bridge.py
- Create: infra/hermes/plugins/readywork_bridge/test_bridge.py

**Interfaces:**
- Produces: hermes_plugin(api) 注册 pre_gateway_dispatch 和 readywork_bridge Platform Adapter。
- Produces: readywork.hermes.bridge.v1 spool envelope、HMAC delivery worker 和出站幂等 ledger。

- [ ] **Step 1: Write the failing test**
  验证事件规范化、确定性回退 message id、原子 spool、附件散列和限制、Bridge 失败保留、成功确认、dispatching 恢复为 unknown。
- [ ] **Step 2: Run test to verify it fails**
  Run: python3 -m unittest infra/hermes/plugins/readywork_bridge/test_bridge.py -v
  Expected: plugin module 不存在。
- [ ] **Step 3: Write minimal implementation**
  用 Python stdlib 完成 SQLite 幂等、os.replace 原子 spool、urllib HMAC 请求和指数退避；spool 成功后 Hook 返回 action skip。
- [ ] **Step 4: Run test to verify it passes**
  Run: python3 -m unittest infra/hermes/plugins/readywork_bridge/test_bridge.py -v
  Expected: PASS。

### Task 7: Hermes 出站适配器

**Files:**
- Create: apps/api/src/messaging/hermes-adapter.ts
- Create: apps/api/test/hermes-adapter.test.ts
- Modify: apps/api/src/messaging/runtime.ts

**Interfaces:**
- Produces: HermesMessagingAdapter implements MessagingAdapter。
- Consumes: MessageDeliveryRequest，调用 POST /readywork/v1/deliveries。

- [ ] **Step 1: Write the failing test**
  验证 accepted 保存真实 provider id、调用前失败可重试、调用后断开为 unknown、dispatching 恢复为 unknown、幂等冲突为 failed-before-dispatch。
- [ ] **Step 2: Run test to verify it fails**
  Run: pnpm exec tsx --test apps/api/test/hermes-adapter.test.ts
  Expected: adapter 模块不存在。
- [ ] **Step 3: Write minimal implementation**
  对原始请求体签名并无损映射四种 Bridge 结果；只有明确未发起外部调用的失败可重试。
- [ ] **Step 4: Run test to verify it passes**
  Run: pnpm exec tsx --test apps/api/test/hermes-adapter.test.ts packages/messaging/test/gateway.test.ts
  Expected: PASS。

### Task 8: 动态中文消息渠道工作台

**Files:**
- Modify: apps/console/features/procurement/messaging-gateway-panel.tsx
- Create: apps/console/features/procurement/hermes-platform-view-model.ts
- Modify: apps/console/test/messaging-gateway-panel-interaction.test.tsx

**Interfaces:**
- Consumes: /api/messaging/platforms、Hermes health API 和 Readywork Weixin onboarding API。
- Produces: 搜索、状态筛选、动态平台卡、配置抽屉、真实微信二维码、自动轮询/保存、测试/onboarding 和 stale 禁用状态。

- [ ] **Step 1: Write the failing test**
  动态 fixture 验证未来新增渠道直接显示官方品牌、中文状态、敏感值不回填、配置 PUT、测试 POST、stale 禁用和中文文案。
- [ ] **Step 2: Run test to verify it fails**
  Run: pnpm --dir apps/console exec tsx --test test/messaging-gateway-panel-interaction.test.tsx
  Expected: 新目录和交互不存在。
- [ ] **Step 3: Write minimal implementation**
  继续使用中央 apiRequest；品牌名来自后端；通用状态映射中文；password/token/secret 只显示已保存或未保存。
- [ ] **Step 4: Run test to verify it passes**
  Run: pnpm --dir apps/console exec tsx --test test/messaging-gateway-panel-interaction.test.tsx test/chinese-ui-contract.test.tsx
  Expected: PASS。

### Task 9: Sidecar 运行工件与 Email 单路开关

**Files:**
- Create: infra/hermes/compose.yml
- Create: infra/hermes/.env.example
- Create: infra/hermes/README.md
- Create: infra/hermes/weixin_onboarding_service.py
- Create: infra/hermes/test_weixin_onboarding_service.py
- Create: apps/api/src/messaging/email-transport-mode.ts
- Create: apps/api/test/email-transport-mode.test.ts
- Modify: package.json

**Interfaces:**
- Produces: resolveEmailTransportMode(env): native 或 hermes，其他值拒绝启动。
- Produces: infra:hermes:up/down/logs/health scripts，以及仅绑定 `127.0.0.1:9121` 的受认证 Weixin onboarding 侧车。

- [ ] **Step 1: Write the failing test**
  验证默认 native、显式 hermes、both/空白/未知值失败，且两条 Email 路径不同时注册。
- [ ] **Step 2: Run test to verify it fails**
  Run: pnpm exec tsx --test apps/api/test/email-transport-mode.test.ts
  Expected: resolver 不存在。
- [ ] **Step 3: Write minimal implementation**
  Compose 镜像固定官方发布 tag、manifest digest 和对应源码提交，挂载 bridge plugin 和 data/hermes，只在 127.0.0.1 暴露管理端口；Dashboard 本体维持容器回环监听，Gateway 使用官方 multiplex_profiles 模式服务隔离租户 profile；Weixin 侧车与 Dashboard 共用会话令牌，仅接受 Readywork profile，凭据不返回浏览器。
- [ ] **Step 4: Run test to verify it passes**
  Run: pnpm exec tsx --test apps/api/test/email-transport-mode.test.ts
  Expected: PASS。

### Task 10: 端到端验收

**Files:**
- Create: scripts/verify-hermes-integration.mjs
- Create: apps/api/test/hermes-integration-contract.test.ts

**Interfaces:**
- Consumes: 运行中的 Hermes Dashboard/Gateway/Bridge 与 Readywork API。
- Produces: 机器可读且不夸大状态的验收结果。

- [ ] **Step 1: Write the failing test**
  缺失 Sidecar、空目录、目录泄露 readywork_bridge、伪连接状态、入站未落库均应使探针非零退出。
- [ ] **Step 2: Run test to verify it fails**
  Run: pnpm exec tsx --test apps/api/test/hermes-integration-contract.test.ts
  Expected: verifier 不存在。
- [ ] **Step 3: Execute complete verification**
  Run: pnpm typecheck
  Run: pnpm test
  Run: pnpm --dir apps/console build
  Run: python3 -m unittest infra/hermes/plugins/readywork_bridge/test_bridge.py -v
  Run: docker run --rm -v "$PWD:/work:ro" -w /work/infra/hermes --entrypoint python nousresearch/hermes-agent:v2026.9.7@sha256:63bfb6d732f49a55d453e801057273785cc61e0f6ee43db3fa2f2a79846301b7 -m unittest test_weixin_onboarding_service.py -v
  Run: docker compose -f infra/hermes/compose.yml config
  Run: docker compose -f infra/hermes/compose.yml pull
  Run: docker compose -f infra/hermes/compose.yml up -d --wait
  Run: node scripts/verify-hermes-integration.mjs
  Expected: 类型、全量测试、Console build、Python 测试、Compose 构建、Hermes 健康、动态目录、HMAC 入站和安全出站探针全部 PASS。
