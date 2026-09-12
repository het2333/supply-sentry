# 企业微信应用引导式接入设计

## 目标

将 Readywork 中的 Hermes `wecom_callback` 渠道从通用环境变量表单改为企业微信应用接入向导。向导自动生成回调校验材料、保存应用凭据、启动 Hermes 适配器并如实展示验收状态；企业管理员仍在企业微信管理后台完成自建应用和回调确认。

## 已确认的约束

- Hermes `wecom_callback` 是双向自建应用适配器：回调接收端固定为 `/wecom/callback`，默认监听 8645 端口，出站通过企业微信 `message/send` API。
- 企业微信要求公网 HTTPS 回调地址，当前本地 `127.0.0.1` 不能作为生产回调地址。仅启动 Hermes 适配器不能证明企业微信已能访问回调。
- 企业 ID、应用 Secret 和 Agent ID 只能由企业微信管理员在官方后台取得；平台不得伪造、猜测或展示已保存凭据。
- Hermes 仍是渠道协议适配器；Readywork 仍是采购业务、审批、入站持久化和 AI 解析的权威系统。

## 方案

在现有 Hermes 动态目录与通用保存接口之上增加一个受管理员权限保护的只读“企业微信接入就绪状态”接口。它只返回部署提供的公网 HTTPS 回调地址及其可用性，不返回任何密钥。部署通过 `READYWORK_HERMES_WECOM_CALLBACK_PUBLIC_URL` 明确配置回调的公网地址；未设置、非 HTTPS、回环/私网主机时，向导阻止提交并明确说明尚需部署公网 HTTPS 反向代理。

控制台将 `wecom_callback` 显示为“企业微信应用（推荐）”，并提供三步向导：

1. 展示经后端确认的回调地址；浏览器用 Web Crypto 仅在当前向导会话生成 Token 与 43 字符 AESKey。这两个值只显示给当前管理员以复制到企业微信后台，既不写入 localStorage，也不落 Readywork 数据库。
2. 管理员在企业微信后台创建自建应用、填写回调地址/Token/AESKey，并将企业 ID、应用 Secret、Agent ID 粘贴进平台。Secret 使用密码输入框，不回填、不出现在成功消息或审计响应中。
3. 控制台将五项值一次性提交给既有 `PUT /api/messaging/platforms/wecom_callback`，再调用既有测试端点。仅当 Hermes 报告真实 `connected` 才显示“适配器已启动”；仍单列“等待企业微信后台回调验证”，避免将本地监听误报为端到端成功。

通用配置弹窗继续保留为高级配置，其他 Hermes 平台不改变行为。

## 后端契约

`GET /api/messaging/wecom/setup-readiness`：要求已登录及读取权限，返回：

```ts
type WecomSetupReadiness = {
  callbackUrl: string | null;
  ready: boolean;
  reason: string | null;
};
```

`ready` 仅在环境变量是合法公网 HTTPS URL 时为 true。该路由不执行外部探测、不写数据库、不包含机密。通用 Hermes 更新端点继续承担真实持久化、字段白名单、幂等审计和启动操作；无需新增凭据表。

## 部署边界

部署必须将公网 HTTPS 路径 `<READYWORK_HERMES_WECOM_CALLBACK_PUBLIC_URL>/wecom/callback` 反代到 Hermes gateway 的 8645 端口。Docker Compose 会将该端口仅映射到主机回环，供本机反向代理使用；是否向公网暴露由 TLS 反向代理、域名和网络策略决定，不由浏览器配置替代。

本地开发可运行并测试“适配器已启动”，但就绪接口应保持不就绪，直到部署显式设置可用的公网 HTTPS 地址。任何“企业微信已连接”状态都必须包含 Hermes 实际连接状态；端到端回调仍需企业微信官方后台的 URL 验证。

## 错误与安全处理

- 非管理员不能读取或提交接入配置。
- 就绪接口拒绝 HTTP、localhost、回环和私网地址，返回中文原因。
- Token/AESKey 仅驻留于当前浏览器内存和最终 HTTPS 请求；组件卸载即丢弃。
- 失败响应、审计记录、通知文案和测试输出均不得包含 Secret、Token、AESKey 或企业 ID。
- Hermes 不可达或目录为过期快照时，向导保持只读且不生成/提交配置。

## 验收

1. API 测试覆盖管理员/非管理员、缺少或无效公网地址及有效地址，且响应不含环境中的秘密值。
2. 控制台测试覆盖未就绪阻断、自动生成两项回调材料、一次性保存五项 Hermes 字段、成功后真实测试、密文不回显。
3. Compose 校验确认 8645 只绑定回环。
4. 完整 TypeScript 检查与相关 API、控制台测试通过。
5. 在当前本地环境，页面必须明确显示“尚未配置公网 HTTPS 回调地址”，而不能显示企业微信端到端已连接。
