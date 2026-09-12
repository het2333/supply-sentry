# Readywork Temporal V1 运行手册

Readywork 本地 V1 使用 Temporal 官方持久化开发服务器，Workflow History 保存到独立 SQLite Docker 卷；生产参考模板使用独立 PostgreSQL。两者都不依赖相邻项目的 Compose、网络、容器或卷。

## 本地启动

```bash
pnpm infra:temporal:up
pnpm infra:temporal:health
pnpm temporal:worker
```

- gRPC：`127.0.0.1:7233`
- UI：`http://127.0.0.1:18082`
- Namespace：`default`
- Task Queue：`readywork-workforce`
- 持久卷：`readywork_temporal_data`

Compose 会先通过一次性 `temporal-volume-init` 将新建持久卷授权给 Temporal 的非 root 用户，再启动服务；无需在宿主机手工改权限。

本地栈只绑定 loopback，适合当前单机 V1 验收，不可直接用于商用生产。生产部署使用 `infra/temporal/compose.production.yml`，并且必须通过部署平台注入 `READYWORK_TEMPORAL_DB_PASSWORD`，不得提交真实值：

```bash
READYWORK_TEMPORAL_DB_PASSWORD='由 Secret Manager 注入' pnpm infra:temporal:up:production
```

## 健康判定

必须同时满足：

1. 本地 `readywork-temporal` 为 `healthy`；生产模板额外要求 PostgreSQL healthy。
2. `pnpm infra:temporal:health` 返回 `SERVING`。
3. Worker 日志显示连接 `127.0.0.1:7233 / default / readywork-workforce`。
4. `/api/operations/readiness` 显示 `workerReady=true` 且 `pollerCount>0`。

应用能连通但容器 `unhealthy`、容器健康但没有 Worker Poller，均不算生产就绪。

## 停止与恢复

```bash
pnpm infra:temporal:down
pnpm infra:temporal:up
```

普通 `down` 不删除 `readywork_temporal_data`。禁止在仍需恢复 Workflow History 时执行 `down -v` 或删除该卷。

Worker 使用 SIGINT/SIGTERM 优雅停止：先停止领取新任务，等待当前 Activity 排空，再关闭模型运行时与 Temporal 连接。重启 Worker 不应创建第二份业务事实；业务写入仍由 Readywork SQLite 中的租约、版本和幂等键保护。

## 生产边界

- 只把 gRPC/UI 暴露到受控网络；本地 Compose 默认仅绑定 `127.0.0.1`。
- PostgreSQL 不映射宿主机端口。
- 生产固定镜像版本并扫描镜像；升级前备份 PostgreSQL 卷并验证 Temporal 官方兼容路径。
- 监控同时采集容器健康、Temporal Cluster Health、Task Queue Poller、Workflow 终态失败和 Readywork 对账状态。
