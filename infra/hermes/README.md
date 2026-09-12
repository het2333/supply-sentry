# Readywork Hermes Gateway

该目录使用 Hermes Agent 官方镜像 `v2026.9.7`，同时固定多架构镜像摘要 `sha256:63bfb6d732f49a55d453e801057273785cc61e0f6ee43db3fa2f2a79846301b7`（源码提交 `2237be355906fbe6065ce1815711eee52b2d646e`），并加载 Readywork 的持久化 HMAC Bridge 插件。Hermes 负责官方渠道适配、配置、连接、引导和协议投递；Readywork 仍是采购业务、审批、入站/出站、幂等与 AI 分析的唯一权威源。

## 启动

1. 复制 `.env.example` 为 `.env`，将两个密钥分别替换为 `openssl rand -hex 32` 生成的独立随机值。
2. 启动 Readywork API 时传入相同的值：

   ```bash
   READYWORK_HERMES_DASHBOARD_URL=http://127.0.0.1:9119 \
   READYWORK_HERMES_DASHBOARD_TOKEN="$HERMES_DASHBOARD_SESSION_TOKEN" \
   READYWORK_HERMES_BRIDGE_URL=http://127.0.0.1:8788 \
   READYWORK_HERMES_BRIDGE_SECRET="$READYWORK_BRIDGE_SECRET" \
   pnpm api
   ```

3. 拉取并启动 Hermes：

   ```bash
   docker compose --env-file infra/hermes/.env -f infra/hermes/compose.yml pull
   docker compose --env-file infra/hermes/.env -f infra/hermes/compose.yml up -d --wait
   ```

Dashboard 只发布在 `127.0.0.1:9119`，微信扫码引导侧车只发布在 `127.0.0.1:9121`，Bridge 只发布在 `127.0.0.1:8788`。Hermes 持久数据位于项目的 `data/hermes`。扫码侧车直接调用固定版本 Hermes 的 iLink 实现，并使用同一 Dashboard 会话令牌验证；账号和 Token 只在服务端保存，不返回浏览器。插件启动脚本只在原有配置中追加 `readywork-bridge`，不会覆盖已有渠道。

Dashboard 本体仍只监听容器内的 `127.0.0.1`，由同容器的字节转发器接到宿主机回环端口，因此继续使用 Hermes 会话令牌且不会形成公开未鉴权监听。Gateway 开启官方 `multiplex_profiles` 模式，一个默认进程为 Readywork 的隔离租户 profile 提供渠道连接；绑定独立端口的渠道若发生 profile 冲突，Hermes 会原样拒绝启用。

## 企业微信应用（平台内引导）

1. 部署前设置 `READYWORK_HERMES_WECOM_CALLBACK_PUBLIC_URL=https://你的域名`，并由 TLS 反向代理把
   `https://你的域名/wecom/callback` 转发到宿主机 `127.0.0.1:8645`。
2. 在 Readywork 的“设置 → 个人微信和其他消息渠道”中，打开“企业微信应用”并点击“配置”。平台会生成只在当前页面有效的 Token 和 AESKey。
3. 在企业微信管理后台创建自建应用，把平台展示的回调地址、Token 与 AESKey 填入后台；再把企业 ID、应用 Secret 和 AgentId 粘贴回平台，点击“保存并测试企业微信应用”。

`8645` 只绑定在宿主机回环地址，浏览器不能替代公网 HTTPS 和企业微信后台的 URL 验证。平台中的“适配器已启动”仅说明 Hermes 已成功配置；企业微信后台仍须完成回调校验。

## 个人微信（无需终端）

1. 打开 Readywork 的“设置 → 自动跟单”。
2. 展开“个人微信和其他消息渠道”。
3. 微信会排在渠道首位；点击“配置”，再点击“生成微信二维码”。
4. 用手机微信扫码并在手机上确认。页面会自动检查结果、保存账号与 Token、启用渠道并重启对应 Gateway profile。

`WEIXIN_ACCOUNT_ID`、`WEIXIN_TOKEN` 和 `WEIXIN_BASE_URL` 不会回填或显示在浏览器。只有自动扫码接入不可用时，才需要展开“高级手动配置”。

## 邮件单路模式

- `READYWORK_EMAIL_TRANSPORT_MODE=native`（默认）：邮件继续使用 Readywork 原生 SMTP/IMAP，Hermes 邮件适配器不注册。
- `READYWORK_EMAIL_TRANSPORT_MODE=hermes`：邮件统一经 Hermes，Readywork 原生 SMTP/IMAP 不启动。

不存在双路模式，以避免重复发送或重复收件。

## 真实性边界

- 未配置第三方凭据的渠道显示“未配置”，不会被标记为已连接。
- Dashboard 不可达时，Readywork 只显示上次成功快照并禁止修改。
- 出站投递在首个外部调用前写入幂等台账；调用后中断会标记“结果未知”，不会自动重发。
- 已保存凭据只显示“已保存”，不会回填明文。

## 常用命令

```bash
docker compose --env-file infra/hermes/.env -f infra/hermes/compose.yml ps
docker compose --env-file infra/hermes/.env -f infra/hermes/compose.yml logs -f gateway dashboard
docker compose --env-file infra/hermes/.env -f infra/hermes/compose.yml down
```
