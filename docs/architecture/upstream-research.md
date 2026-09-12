# 上游架构研究记录

研究快照保存在工作区 `.research/upstream`，用于内部架构对照，不进入产品运行路径。

| 项目 | 研究版本 | 采用方式 |
| --- | --- | --- |
| Graphon | `cb0194f35b62` | 参考事件驱动图执行、共享状态和节点调度；兼容 Apache-2.0 的设计思想，TypeScript 独立实现 |
| Dify plugin-daemon | `b1d37034a251` | 参考插件生命周期与隔离运行；TypeScript 独立实现本地子进程协议 |
| n8n | `616dd652c886` | 研究节点描述、Credential 与 nodes-base 组织方式；不直接复制受限代码 |
| Dify | `a6ace29e1a71` | 研究 Node Factory、Human Input、WorkflowRun/NodeRun；不直接复制受限代码 |

实现层保留这份最小内部溯源记录，产品 UI 不增加上游品牌标识。

## 第一轮吸收结果

这轮研究已从“阅读参考代码”进入产品实现，采用的不是一份静态连接器清单，而是独立的 Connector 控制面：

- 参考 n8n 的节点与 Credential 描述方式，建立声明式 `ConnectorDescriptor`、`ConnectorActionDescriptor` 和 `ConnectorCredentialSchema`。连接器声明字段、密钥、输入、输出、副作用、幂等性与风险，控制台据此自动生成配置界面。
- 参考 Dify / Graphon 的节点工厂和执行边界，Connector Action 通过统一注册表进入节点运行时，Editor 不需要为每种客户系统维护专用表单和调用逻辑。
- 参考 plugin-daemon 的隔离思想，实现 `builtin`、`local_process`、`debug_process`、`remote_http`、`serverless` 五种运行时描述。当前 HTTP Connector 已在受监管的本地子进程运行。
- 插件进程使用 NDJSON 请求协议，常驻复用同一进程，并具备并发上限、单次超时、异常退出回收和优雅关闭能力。插件只继承明确允许的环境变量。
- 安装、启用、停用、升级、卸载、凭据保存和连接测试均写入租户级事件审计，不再用前端假状态表示连接成功。

## 当前 Connector 目录

第一批共 14 个目录项：企业邮箱、ERP、采购台账、HTTP、Webhook、SAP S/4HANA、金蝶云、用友、企业微信、钉钉、飞书、WMS、MES、数据库。

其中企业邮箱、ERP、采购台账为内置运行时；HTTP 已完成隔离子进程安装；其余客户系统已具备标准描述、凭据表单与生命周期入口，后续只需补对应 Adapter，不需要修改主后端或 Editor。
