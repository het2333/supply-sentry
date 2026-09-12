# Readywork 阿里云服务器部署设计

## 目标

将当前 Readywork 单机工作区部署到 Ubuntu 24.04 阿里云服务器 `47.102.116.148`，让 Console、业务 API、控制 API、Temporal Worker、Temporal、Hermes Gateway 和持久化数据作为一套可审计、可备份、可回滚的部署运行。

本次首先交付“服务器私有预览”：所有业务端口仅绑定服务器回环地址，用户通过 SSH 隧道访问。在已备案域名、正式身份提供方、S3/OSS 对象存储和 TLS 证书就绪前，不向公网开放 Console 或 API。

## 已确认的约束

- 服务器：Ubuntu 24.04.2 LTS，x86_64，公网 IPv4 `47.102.116.148`。
- 当前服务器对自动化 SSH 连接拒绝公钥认证；用户不在聊天中提供密码或私钥。
- 代码库要求 Node.js `>=22.18`、pnpm `11.7.0`，并使用 Node 内置 SQLite。
- 当前没有生产 Dockerfile，需要在仓库中增加可重复构建的容器边界。
- `NODE_ENV=production` 会禁用演示账号，且强制要求 S3 附件存储；因此没有正式 IdP 和 OSS/S3 时不冒充“生产就绪”。
- 当前本机业务数据位于 `data/readywork.sqlite`，Hermes 数据位于 `data/hermes/`。部署前必须一致性备份，不复制明文凭据。

## 方案

使用一个 Readywork 应用镜像承载同一份已锁定源码和 pnpm 依赖，由 Docker Compose 以不同命令启动 Console、业务 API、控制 API 和 Temporal Worker。Temporal 使用现有 PostgreSQL 生产参考组合；Hermes 使用已固定版本和镜像摘要的官方镜像。

宿主机只发布 `127.0.0.1:3001`、`127.0.0.1:4173`、`127.0.0.1:4174`、`127.0.0.1:7233`、`127.0.0.1:8645` 等回环端口。首次验收通过 SSH 隧道访问 `3001`；后续公网切换时再增加 Caddy，只将业务域名的 HTTPS 流量反代到 Console，将 `/wecom/callback` 反代到 Hermes 回调端口。

## 数据与密钥

1. 迁移前暂停本机写入工作器，使用 SQLite 在线备份生成一致性数据库副本，记录 SHA-256、文件大小和 `PRAGMA integrity_check`。
2. 迁移数据库、实际附件对象和 Hermes 持久数据；排除日志、临时会话、`node_modules`、构建缓存和任何未管理的明文 `.env`。
3. `READYWORK_SESSION_SECRET`、`READYWORK_CREDENTIAL_KEY`、Hermes Bridge Secret、Temporal 数据库密码在服务器上独立生成，以 root 可读的 env 文件或 Docker Secret 传入，不进入镜像、代码库、日志或聊天。
4. 旧 SQLite 中的加密连接器凭据不会在新密钥下冒充可用。部署后通过平台设置页重新保存并测试邮件、DeepSeek、Odoo 和消息渠道凭据。

## 认证与公网边界

私有预览阶段允许非生产模式的演示登录，但仅通过 SSH 隧道访问，阿里云安全组不开放 `3001/4173/4174/7233/8645`。公网切换前必须同时满足：

- 已备案业务域名解析到服务器；
- 企业身份提供方能生成 Readywork 可验证的租户、用户和角色会话；
- OSS/S3 桶、HTTPS endpoint 和服务端加密已配置；
- Caddy 证书签发成功，只开放 `80/443`；
- 企业微信回调 URL 通过官方验证。

## 发布与回滚

- 发布时先生成不变的 `release_id`，服务器目录使用 `/opt/readywork/releases/$release_id`；`/opt/readywork/current` 为当前版本软链接，`/opt/readywork/shared` 保存持久数据和密钥。
- 新版本先构建、执行配置检查和容器健康检查，再切换 `current`。
- 发布前备份 SQLite 与 Hermes 状态；回滚时停止写入工作器、恢复前一版本及其对应数据备份，然后重做健康检查。
- 不删除本机平台和本机数据，直到服务器通过验收且用户另行决定切换。

## 验收标准

- Compose 所有必需容器健康，重启服务器后自动恢复。
- SSH 隧道中 Console 可登录，业务 API 和控制 API 健康端点返回成功。
- 迁移前后 SQLite 完整性为 `ok`，采购文档数量与关键 PO 存在性一致。
- 页面刷新后数据仍存在，Console 操作读写同一个服务器 SQLite。
- 未重新配置或未通过真实测试的连接器显示“未配置/不可用”，不复用本机运行观测或伪造成功。
- 私有预览期间公网无法直接访问业务端口；公网切换后仅 `80/443` 可达。
