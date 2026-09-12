# SupplySentry（交付哨）

[English](README.md) | 简体中文

面向制造业的采购执行与供应商跟单平台。GitHub 项目名称为 SupplySentry；现有工程目录、`@readywork/*` 包、`READYWORK_*` 配置和部署服务仍使用 Readywork 标识。


随时待命的 AI 员工班组。**底层通用，产品垂直**：一个 Business Runtime 微内核 + 插件化 Worker/Workflow/Skill/Tool/Context，再以 Employee Pack 形式交付行业员工（供应链、销售、财务、客服…）。

> Harness 管 AI 怎么思考和行动；Business Runtime 管企业业务现在进行到哪一步。

> **采购产品 V1 唯一口径：** [docs/PROCUREMENT-V1-SCOPE.md](docs/PROCUREMENT-V1-SCOPE.md)。逐页功能、视觉、数据合同和发布门槛见 [docs/NAVISIGHT-V1-ALIGNMENT.md](docs/NAVISIGHT-V1-ALIGNMENT.md)。当前 V1 以 Navisight 公开可验证的 `PO Sent → Supplier Commitment → Fulfilment / Production → Dispatch / Transit → Delivery / GRN` 为基线。仓库中的 RFQ、发票 / 应付、Teams 和通用运行时能力可以继续存在，但不计入采购执行 V1 的上线完成度。
>
> **平台演进顺序：** 先完成 Navisight 采购员工 V1，并将其作为第一个 Employee Pack；随后依次建设通用 Governance、App Builder 和多员工主管台。完整约束见 [docs/PLATFORM-ROADMAP.md](docs/PLATFORM-ROADMAP.md)。
>
> `docs/ARCHITECTURE.md`、`docs/V1-DESIGN.md` 和下述 demo 链记录的是早期平台运行时里程碑，不再定义采购产品 V1 范围。

## 仓库结构

```
docs/                       架构蓝图（先读 ARCHITECTURE.md）
packages/
  core/                     ① Business Runtime 微内核（事件/组织/员工Spec/审批/Policy/预算/调度/Task状态机/Worker/端口/仓储）
  agent/                    ④ Agent Runtime（默认 DeepSeek Harness + 显式 InMemory 测试桩）
  workflow/                 ④ 流程层引擎（agent/tool/skill/wait/approval/condition/notify/end）
  skills/                   ⑤ 能力层插件系统（SkillRegistry）
  tools/                    ⑥ 工具层插件系统（ToolRegistry + 内存参考工具：ERP/Email/PDF/Excel）
  context/                  ⑤ Enterprise Context Graph（内存实现）
  control-tower/            ⑨ Control Plane 控制塔查询（KPI/状态/审批）
  persistence/              node:sqlite 持久化（仓储实现 + 崩溃恢复）
  evals/                    Evaluations（轨迹录制/评分/回归对比）
  supply-chain/             第一个真实 Employee Pack（Navisight 采购执行员工）
apps/
  demo/                     验证链演示（InMemory 桩）
  demo-dsh/                 DeepSeek Harness Adapter 验证链（无 key 自动起 mock 模型）
  demo-persist/             持久化与崩溃恢复演示
  demo-mcp/                 MCP 工具桥演示（agent 原生 tool-calling）
  validation/               共享验证链（demo 与 demo-dsh 复用，业务层零改动）
  mock-model/               OpenAI 兼容 mock 模型端点（脚本化决策 / 原生 tool-calling，SSE 流式）
  mcp-bridge/               MCP 工具桥（stdio shim + 主进程执行器 + cordis.mcp.yml）
  evals/                    Evaluations 回放评测脚本
  web/                      Web Control Tower 仪表盘（node:http 零依赖）
  console/                  Next.js + Tailwind「员工优先」控制台（员工详情/Workers/Workflows/Skills/Tools/Policies/审批）
  api/                      最小 HTTP API（node:http，零依赖）
```

## 快速开始

需要 Node.js **22.18 及以上版本**（推荐 Node.js 24 LTS）和 **pnpm 11.7.0**；Node.js 20 不支持本项目使用的 `node:sqlite`。

```bash
pnpm install --frozen-lockfile
pnpm typecheck     # 全仓类型检查
pnpm test          # 状态机 / Policy / Workflow / Adapter / 持久化 / MCP 桥 测试
pnpm demo          # 平台运行时演示链（InMemory 桩；不作为采购产品 V1 验收）
pnpm demo:dsh      # 真实 DeepSeek Harness runtime 重跑验证链（无 key 自动起 mock 模型）
pnpm demo:persist  # node:sqlite 持久化与崩溃恢复演示
pnpm demo:mcp      # MCP 工具桥：DSH agent 原生 tool-calling 调用我们的工具
pnpm eval          # Evaluations 回放评测（正常交付 vs 延期交付回归对比）
pnpm api:business  # 业务面 API → http://127.0.0.1:4173
pnpm api:control   # 控制面 API → http://127.0.0.1:4174
pnpm temporal:worker # Temporal Worker；AI 节点默认调用 DeepSeek Harness
pnpm console       # Next.js 业务/开发者控制台 → http://127.0.0.1:3001
pnpm web           # 零依赖 Control Tower 仪表盘（备用）→ http://127.0.0.1:4180
```

## 源码与本地运行数据

版本库包含源码、测试、依赖锁文件、部署脚本、文档及必要静态资源。真实环境配置、API 密钥、邮箱授权码、业务数据库、Hermes 登录状态、运行日志、依赖目录、构建缓存和历史部署包均由 `.gitignore` 排除，克隆仓库不会获得现有环境的订单或登录凭据。

环境配置模板保留在 `.env.example`、`infra/hermes/.env.example` 和 `infra/production/.env.preview.example`，按所选运行方式在本机或服务器单独配置实际值。`data/`、`.readywork/` 中的业务数据和凭据需要另行备份；它们不属于可随意删除的缓存。`.research/`、`.superpowers/`、`artifacts/` 是本地研究与历史验收材料，文档中的对应路径不会随 GitHub 源码一起上传。

## 本地认证与监听

控制台和 API 的演示认证默认关闭；控制台默认只监听 `127.0.0.1`。如需本机启动验收，可只对当前 API 命令临时设置 `READYWORK_DEMO_AUTH=1`，然后从 Web 登录页建立 HttpOnly 会话。该开关只启用本地验收账户，不再隐式授予匿名管理员；高风险兼容开关 `READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH=1` 必须另行显式设置，正常验收不应使用。不要将这些变量写入部署环境、`.env` 或版本库文件，也不要在文档或配置中保存演示密码、会话密钥或真实凭据。无论变量为何值，`NODE_ENV=production` 都会拒绝演示认证；生产环境应配置独立的强 `READYWORK_SESSION_SECRET` 并接入正式身份提供方。

## 平台运行时演示链（非采购产品 V1 验收）

`pnpm demo` 依次演示：

**创建员工 → 给权限 → 给业务任务 → AI执行 → 等待 → 恢复 → 调工具 → 人工审批 → 完成 → 评测**

覆盖三张员工卡：采购需求员工（大额审批）、询价员工（报价收集→比价→中标审批）、PO 供应商运营员工（交期确认→延期检测→催交→到货关闭）。

这条 demo 链只验证通用运行时编排。采购产品 V1 是否完成，只能按 [采购执行 V1 范围与验收契约](docs/PROCUREMENT-V1-SCOPE.md) 中的真实 API、SQLite、连接器回执、权限、审计和十项上线验收判断。

## 技术要点

- TypeScript + pnpm monorepo；业务 API 主要使用 Node 原生能力，控制台使用 Next.js，可靠编排使用 Temporal
- 当前生产 AI Runtime 默认使用 **DeepSeek Harness**；`InMemoryAgentAdapter` 仅供显式测试与确定性回归
- `HarnessRuntime` 使用 JSON-RPC stdio（与官方 SDK 同一
  wire 契约）+ `DeepSeekHarnessAdapter`；`pnpm demo:dsh` 以真实 DSH runtime 子进程重跑验证链，
  无 key 时自动使用 `apps/mock-model`（OpenAI 兼容端点），有 `DEEPSEEK_API_KEY` 即直连真实模型
- P2 Temporal 图运行中的 AI 节点通过 `AgentRuntimePort` 进入 Harness；所有 ERP、邮箱等副作用仍统一经过 Action Gateway
- 采购执行链已提供版本化 PO/发票/行级三单、审批绑定续跑和持久化 Outbox；只有外部连接器明确成功，PO 发送或 ERP 应付回写才推进为已派发/已回写，超时结果转人工对账而不重复发送
- 控制面生产就绪度聚合 Temporal worker/poller、Action/Outbox 租约、失败队列、连接器/凭据与安全告警；未配置或未观测到真实服务时明确显示未就绪
- Teams 协同使用租户 + AAD 身份绑定、Bot Framework JWT/JWKS 校验和 OAuth 主动通知；Bot、身份绑定、会话或凭据缺失时返回 unavailable，绝不假报已发送
- 默认 Harness composition 为 decision-only：不加载 Bash、文件系统、MCP、ERP 或邮件工具；子进程按员工隔离，且只继承最小环境变量白名单
- 一切业务状态通过领域事件驱动：`Task` 状态机 + `Wait/Resume/Retry/Approval` + 事件恢复

启动 Temporal Worker 前必须显式设置 `READYWORK_DSH_REPO` 和远端模型的 `DEEPSEEK_API_KEY`。只有本地确定性回归才使用 `READYWORK_AGENT_RUNTIME=inmemory`；缺少 DSH 配置会直接失败，不会静默降级。

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
