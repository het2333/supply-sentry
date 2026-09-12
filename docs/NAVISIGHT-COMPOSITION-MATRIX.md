# Readywork × Navisight 能力组合矩阵

更新日期：2026-08-30。目标是优先复用现有实现和宽松许可组件，加快能力对齐；商业授权只在明确产生业务价值时引入。本文不等于依赖已安装，所有新增依赖仍需单独设计、许可证复核和验收。

| 能力 | 当前基础 | 首选组合 | 许可证/风险 | 决策 |
|---|---|---|---|---|
| PO / 任务 / 通知表格 | React + Tailwind，自建表格 | TanStack Table + TanStack Virtual | MIT | 数据量、列固定、虚拟滚动和无障碍复杂度上升时引入；短期保留稳定自建表格 |
| 工作流画布 | `@xyflow/react@12.11.3`，已有 Workflow Canvas | 保持 XYFlow；只有 BPMN XML 互操作才加 bpmn-js | XYFlow MIT；bpmn-js MIT | 不更换现有画布 |
| PDF / 附件并排 | 安全附件 URL、图片/PDF 内嵌、ClamAV | react-pdf + PDF.js；服务端 Tika | react-pdf MIT；PDF.js/Tika Apache-2.0 | 优先补页缩略图、证据跳转和 PO/发票并排，不让浏览器 PDF 解析成为权威数据源 |
| 邮件线程 | SMTP/IMAP、message drafts、Outbox、Communication | 自建线程 UI；后续 Gmail API / Microsoft Graph OAuth | API 条款与配额；Nodemailer MIT | 现有持久化/审计继续作为权威，不由供应商 SDK 决定状态 |
| 审计时间线 | append-only procurement events、Twin events、Outbox | 自建统一时间线；超长交互可选 vis-timeline | vis-timeline MIT | 优先统一对象深链，不新增审计 SaaS 依赖 |
| Manufacturing Context 图谱 | Twin entities/relations/evidence/snapshots | Cytoscape.js + graphology | MIT | 只做可视化；SQLite 仍是权威事实，不立即引入图数据库 |
| Durable runtime | Temporal server + TS SDK + Worker | 继续 Temporal；需要 BPMN 标准时再评估 bpmn-js/Camunda | Temporal MIT；Temporal Cloud/Camunda 商业边界需复核 | 不更换运行时 |
| Odoo | 本地 Odoo connector、Outbox、读回与映射 | 继续自建 connector；按版本使用 Odoo 官方 API | Community LGPLv3；Enterprise proprietary | 不复制 Enterprise 模块代码；客户许可与 API 版本单独确认 |
| 附件解析/病毒扫描 | 对象存储、SHA-256、security status、ClamAV | Apache Tika + 独立 ClamAV 服务 | Tika Apache-2.0；ClamAV GPLv2 | 扫描器作为隔离服务部署并记录引擎版本/签名水位 |
| 对象存储 | SQLite/S3/MinIO 适配 | S3 API；MinIO 需许可证审查 | 新版 MinIO AGPLv3 / 商业支持 | 商用部署前确认分发/网络服务义务，必要时换云 S3 或商业对象存储 |
| 全局搜索 | SQLite 结构化过滤、业务搜索 API | 近期 SQLite 索引；跨邮件/OCR/Twin 后使用 OpenSearch | OpenSearch Apache-2.0 | 不把 SQLite FTS 当多租户全文检索终局 |
| 可观测性 | 运行事件、readiness、Temporal 状态 | OpenTelemetry + Prometheus/Grafana；可选 Sentry | OTel/Prometheus/Grafana OSS；SaaS/Enterprise 商业 | 所有邮件/PDF/联系人字段先脱敏再出遥测 |
| Advanced SLA | 五阶段 SLA、Production、Shipment、Transport、Import Docs、GRN | 复用现有事实层，自建 9 域版本化规则；CSV 用成熟 parser/schema validator | 优先 MIT/Apache-2.0 | 不引入另一套 BPM 引擎；规则层与运行事实层严格分离 |

## 引入顺序

1. 先完成真实 PO 五阶段闭环和 Odoo 映射恢复，不让新 UI 依赖掩盖业务断链。
2. 建统一视觉令牌、PageHeader、产品壳和 PO 六页签；表格仍可使用当前实现。
3. Advanced SLA 九域先完成 schema、版本、预览、审批和审计，再做 CSV。
4. react-pdf/PDF.js 用于证据阅读体验；Tika/ClamAV 继续负责服务端安全与解析事实。
5. Cytoscape.js 只在 Twin 图谱查看器落地时引入。
6. OTel/Prometheus 在连接器、Worker、扫描与 SLA 自动发送进入生产前完成。
7. 数据规模和检索范围实际超过 SQLite 后再引入 OpenSearch。

## 商用前许可证清单

- MinIO AGPLv3 或商业授权边界。
- ClamAV GPLv2 的独立服务部署和分发方式。
- Odoo Enterprise 客户订阅与 API 使用权。
- AG Grid Enterprise、Tiptap 商业扩展、Camunda/Temporal Cloud 等可选商业能力。
- Gmail、Microsoft Graph、WhatsApp/Meta 的 API 条款、数据保留和消息模板政策。

任何“先试用、后买许可”的组件都必须在部署清单中标注，不得在正式商用发布前遗漏。
