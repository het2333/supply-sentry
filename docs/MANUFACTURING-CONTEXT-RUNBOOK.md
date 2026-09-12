# Manufacturing Context / Twin 运行手册

## 边界与权威数据

`procurement_documents`、`procurement_lines`、阶段事件、Outbox、Odoo 回执、Shipment 和仓库 GRN 仍是权威事实。Manufacturing Context / Twin 只是按租户隔离的可重建投影，不能回写或替代采购事实。任何 `lagging`、`degraded` 或 `unavailable` 状态都表示投影可能过时，不表示权威 PO 丢失。

Twin 不存储邮箱凭据、authorization/cookie/token、原始邮件正文或附件字节。排障输出和工单中也不得复制这些内容。

## 启动 Worker

业务 API 进程会为数据库中发现的租户启动 Manufacturing Context coordinator，每 3 秒轮询，每个租户使用独立 Store / Queue / Projector，并在首次发现时补齐幂等 PO backfill。每次成功轮询（包括没有 pending job 的空轮询）都使用单条 atomic UPSERT 向 `twin_projection_worker_heartbeats` 发布当前 `tenant_id` + `worker_id` 的 durable heartbeat。较旧时间不得覆盖较新 heartbeat。

```bash
DB_PATH=data/readywork.sqlite pnpm api:business
```

兼容面 `pnpm api` 也会启动投影；`READYWORK_API_SURFACE=control` 的控制面永远不启动 Context Worker，也不提供 Context 读接口。控制面的 `/api/operations/v1-readiness` 只从共享 SQLite 读取当前租户的 durable heartbeat；不能读取业务进程内存状态，也不得为了 readiness 启动第二个 Worker。启动日志应包含：

```text
[context] Manufacturing Context 多租户投影 coordinator 已启动（每 3s）
```

不要为验收停掉已在运行的 API 或 Console；SQLite WAL 和 5 秒 busy timeout 允许它们与幂等验收共存。

## 健康检查

1. 检查业务 API：`GET http://127.0.0.1:4173/health`。
2. 使用已登录且具有 `configure` 或 `admin` 权限的会话读取 `GET /api/context/v1/projections/status`。不要把会话 cookie 或 authorization 值写入文档、日志或聊天。
3. 响应中核对 Worker 心跳、队列计数、最近成功 watermark 和投影状态。Readiness 的 `manufacturing_context` gate 只在以下条件同时满足时 ready：当前租户有 durable heartbeat、Worker ready、心跳年龄在 `0..2 * pollIntervalMs` 内、当前租户无 `dead_letter`，且最早 `queued` / `retry_wait` 不超过 10 分钟。heartbeat 缺失、过期或来自未来时间都 fail closed；其他租户的 heartbeat 不得使当前租户就绪。

## 队列 SQL 诊断

所有查询必须显式限定 `tenant_id`，并使用只读模式。

```bash
sqlite3 -readonly -header -column data/readywork.sqlite "SELECT status,COUNT(*) AS count FROM twin_projection_jobs WHERE tenant_id='t:acme' GROUP BY status ORDER BY status;"

sqlite3 -readonly -header -column data/readywork.sqlite "SELECT MIN(available_at) AS oldest_pending_at,COUNT(*) AS pending_count FROM twin_projection_jobs WHERE tenant_id='t:acme' AND status IN ('queued','retry_wait');"

sqlite3 -readonly -header -column data/readywork.sqlite "SELECT id,source_table,source_key,source_revision,event_type,attempts,available_at,updated_at FROM twin_projection_jobs WHERE tenant_id='t:acme' AND status='dead_letter' ORDER BY updated_at,id;"

sqlite3 -readonly -header -column data/readywork.sqlite "SELECT worker_id,worker_ready,last_heartbeat_at,poll_interval_ms,updated_at FROM twin_projection_worker_heartbeats WHERE tenant_id='t:acme' ORDER BY last_heartbeat_at DESC,worker_id;"
```

默认不查询 `last_error` 和载荷 JSON；必须进一步诊断时，仅在受控终端查看经过脱敏的错误摘要。

## 死信重放授权

`dead_letter` 不得自动重放。先确认权威源行仍存在、`source_revision` 和 `payload_hash` 相符，查明错误原因，并由当前租户具有 `configure` 或 `admin` 权限的人员批准。批准后使用经过身份验证的业务 API：

```text
POST /api/context/v1/projections/:jobId/replay
```

重放只能修复 Twin 投影，不能创建或改写 PO、Odoo 单据、Shipment 或 GRN。完成后再次检查队列计数和新 watermark，保留授权人、原因和时间的审计记录。

## Backfill 语义

`purchase_order.backfill` 只从当前权威行重建 Twin。同一租户、源表、源键、源修订和事件类型是幂等键，相同载荷摘要不会重复创建 job、entity、relation 或 evidence。

迁移期间根据当前 PO 状态恢复的历史必须标记为 `observed_backfill`。它表示“观测到状态”，不是精确的外部完成回执，不得用来虚构五阶段闭环。对本手册的真实 PO，当前阶段仍是 `supplier_commitment`，且 Odoo PO、供应商确认、生产进度、Shipment 和 GRN 仍是明确缺失事实。

## 快照限制与证据优先级

快照是不可变的权限过滤读模型：图深度最大 2，最多 500 个 entity、2,000 条 evidence 和 50 条最近 Agent Event，序列化上限 512 KiB。超限时响应必须显式返回 `truncated` 和 cursor；不得把截断误解为“没有更多事实”。快照必须在 Agent 决策前创建，后续 Agent Event 通过 `input_snapshot_id` 共享同一快照 ID。

解析同一 fact path 时的优先级为：

1. `verified_external` = 400；
2. `approved_human` = 300；
3. `deterministic` 和 `observed_backfill` = 200；
4. `model_derived` = 100。

优先级不能消除冲突证据；非中选且值不同的证据仍必须作为 conflict 呈现。

## 事故响应

1. 确定受影响的 `tenant_id`，检查 API `/health`、Context 心跳和队列分组计数。
2. 若只有积压，保持业务 API 运行，观察最早 pending 时间和 watermark 是否前进；不要通过删队列来“恢复绿色”。
3. 若心跳超过 6 秒，核对业务 API 进程、SQLite 可写性和锁等待，再做可恢复的进程重启。
4. 若出现死信，按上述授权流程核对源修订和载荷摘要，不得自动或批量重放。
5. 在事故期间，所有采购判断回到权威 SQLite 事实；不得使用过时 Twin 补全缺失的供应商确认、发运或 GRN。
6. 恢复后运行只读 SQL 和真实 PO 验收，核对两次投影计数稳定、snapshot / Agent Event 关联和无 `dead_letter`。

## 真实 PO 验收

在仓库根目录运行下列精确命令：

```bash
pnpm validate:manufacturing-context
```

该命令只针对 `t:acme` 的 `po:7c4c2aa5-b119-4e14-8953-a9fc78882e2a`，使用 `data/readywork.sqlite` 的真实事实，拒绝 `:memory:`。它只执行幂等 Context backfill、Context snapshot 和关联 Agent Event，并且只打印计数、ID、watermark 和哈希。

验收不发送邮件，不创建 Odoo PO，不创建 Shipment，不创建 GRN，不改写权威采购事实。
