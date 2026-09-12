# Navisight 对齐组件选型矩阵

> 盘点日期：2026-08-28。范围是 `apps/console` 的采购控制台，不改变代码或依赖。本矩阵按“真实 API/SQLite 数据、可恢复状态、审计和人工门禁”约束评估；组件只负责呈现与交互，不能替代业务状态机。

## 当前基线

`apps/console/package.json` 当前为 Next `latest`（lockfile 解析为 16.3.1）、React 19.2.8、Tailwind CSS、`class-variance-authority`、`clsx`、`tailwind-merge`、Lucide React 和 `@xyflow/react` 12.11.3。现有 `components/ui` 只有 Button、Badge、Progress、Card；采购页面已有工作台、风险、通知、草稿、路线、SLA 等领域组件。`apps/api` 已有 `pdfjs-dist` 6.2.108，但它不是 console 的直接依赖，不能假设浏览器端可直接 import。

## 推荐矩阵

| Navisight 能力 | 首选组件/库 | 许可证与商用条件 | 包体/集成成本 | 结论与边界 |
|---|---|---|---|---|
| 数据表：PO、供应商、通知、风险明细 | **TanStack Table v8**（headless）+ 现有 Tailwind UI | MIT；无运行时服务费 | 中低；约需自行做表头排序、列显隐、虚拟滚动和无障碍 | **P0 推荐**。数据、筛选、分页和 URL 状态由页面/API 控制；不要把筛选结果缓存为业务事实。大量行再加 TanStack Virtual（MIT）。 |
| 表格外观与弹层/下拉 | 继续扩展现有自建 primitives；可选 shadcn/ui 代码复制模式 | shadcn 组件源码 MIT（底层 Radix 多为 MIT）；复制进仓库需按各组件保留声明 | 低到中；不引入大套件，需维护本地 API | **P0 推荐**。Navisight 的紧凑卡片、Badge、Popover、Dialog 更容易保持视觉一致；避免整包 MUI/Ant Design。 |
| KPI、风险分布、趋势、供应商排行 | **Recharts** | MIT；无服务费 | 中；SVG 图表易接 React，但图表模块会增加 bundle | **P0 推荐**，仅客户端按页面动态加载。趋势不足两个真实快照时显示“待积累”，不画估算线。金额按币种分组，禁止组件层盲目求和。 |
| 复杂/高密度分析图 | **visx**（按需包）或原生 SVG | MIT | 中高；API 更底层，需自己处理坐标轴、响应式和 tooltip | P1 备选。只有 Risk Dashboard 的交互密度证明 Recharts 不够时采用；不要同时引入 Recharts 与 visx。 |
| 日期范围、相对时间、时区 | **react-day-picker** + **date-fns** | 两者 MIT | 低；需明确 locale/timezone 规则 | **P0 推荐**。Risk Dashboard 日期必须传 API 查询并可复现；展示层统一 Asia/Shanghai 或用户时区，存储仍用带时区 ISO/UTC。 |
| 命令搜索（全局 PO/供应商/页面动作） | **cmdk** + 自建 API 搜索 | MIT | 低；键盘导航和焦点管理成熟，后端搜索仍需实现 | **P0 推荐**。只展示权限范围内结果；动作需调用真实 API，不能用 command palette 直接伪造“已发送/已读”。 |
| 邮件阅读：草稿队列、正文、引用/附件 | 轻量自建双栏 + DOMPurify（若渲染 HTML） | DOMPurify Apache-2.0/MPL-2.0 双许可；自建代码按仓库许可证 | 低到中；邮件 MIME、CID 图片、附件下载、安全策略是主要成本 | **P0 推荐**。正文默认纯文本/安全 HTML；外部图片和脚本禁用，附件走后端权限和病毒扫描；Approve & Send 必须等连接器回执后更新状态。 |
| 邮件富文本编辑（可选） | **Tiptap** core/starter-kit | MIT；部分 Pro 扩展商业许可，需逐项核对 | 中；编辑器、schema、粘贴清洗和 SSR 较复杂 | P1/按需。V1 只需编辑已生成草稿，先用 textarea/安全 Markdown；若选 Tiptap，锁定 MIT 扩展，避免误用 Pro 包。 |
| PO 五阶段 Timeline | 自建 Tailwind + Lucide 图标（CSS connector） | 项目自有；Lucide ISC，可商用 | 低 | **P0 强推荐**。固定五阶段、Completed/Active/Pending 和 observed/backfill 是领域语义，通用 timeline 容易隐藏缺失事件；事件来自不可变 API。 |
| 文件预览：PDF/单证 | **react-pdf**（底层 pdfjs-dist）或直接封装 PDF.js | react-pdf MIT；PDF.js Apache-2.0 | 中高；worker、字体、SSR 禁用、内存和大文件分页 | P1 推荐。先做下载/元数据/安全扫描；需要页内预览时在客户端动态 import，worker 版本与 pdfjs-dist 锁定，文件通过短期授权 URL 获取。 |
| 文件预览：图片/文本 | 原生 `<img>`（受限 object URL）/纯文本 viewer | 浏览器能力；无额外许可 | 低 | **P0/P1 推荐**。限制 MIME、大小、下载权限；不要把供应商附件当作可信 HTML。 |
| 地图：运输路线、节点、ETA | **MapLibre GL JS** + `react-map-gl/maplibre` | MapLibre BSD-3-Clause；react-map-gl MIT；底图/瓦片服务另有许可与费用 | 中高；WebGL、客户端动态加载、地图 token/配额和隐私 | P1 推荐（Import 真实运输闭环后）。供应商底图不是免费许可的默认事实；生产需明确 OSM/商业瓦片归属、缓存和配额。无坐标时显示节点列表，不画假路线。 |
| 运输节点图（装运、清关、到港、到货） | 自建节点列表/横向 stepper；复杂关系才复用已有 `@xyflow/react` | 自建；`@xyflow/react` MIT | 低（自建）/中（Flow） | **P0 用 stepper/list**。现有 XYFlow 更适合 workflow canvas，不建议为线性物流时间线引入画布、缩放和节点拖拽；若后续做多承运商依赖图再使用。 |
| 导出 CSV | 自建 RFC 4180 serializer 或 `csv-stringify` | 自建；csv-stringify MIT | 低 | **P0 推荐自建**，导出当前筛选后的真实快照；字段、币种和生成时间写入审计/下载记录。 |
| Toast、确认、加载/错误状态 | 扩展现有 primitives；可选 Sonner | Sonner MIT | 低 | P0 可选。Toast 不能代表副作用成功；成功提示只能绑定 API 明确成功和幂等响应。 |

## 依赖落地顺序

1. 先扩展本地 primitives，再加 TanStack Table、react-day-picker/date-fns、cmdk；它们直接覆盖 Overview、Notifications、Suppliers、Risk Dashboard 的 P0 交互。
2. 图表只选择 Recharts（按路由动态加载），并为无数据/单快照/多币种建立明确空态。
3. 邮件和 Timeline 优先自建，因其安全与审计语义比通用组件重要；HTML 邮件在引入 DOMPurify 前不得渲染。
4. Import 的真实运输事实验收后再引入 MapLibre；PDF 预览在附件权限、ClamAV/安全门禁和短期 URL 完成后再引入 react-pdf。

## 许可证与供应链门禁

- 生产锁定具体版本和 lockfile；避免 `latest` 继续漂移。新增包须记录 SPDX 许可证、传递依赖和是否含字体/图标/底图数据。
- MIT/ISC/BSD/Apache-2.0 通常适合商用，但仍保留 NOTICE/版权文本；Apache-2.0 的 NOTICE 要求不能删除。不要把地图瓦片、字体、图标包的许可与代码库许可混为一谈。
- 避免 AGPL/GPL 组件进入浏览器 bundle，除非法务明确批准；商业扩展（例如编辑器 Pro、地图/瓦片 SaaS、托管图表）必须单独记录账号、配额、数据驻留和离线降级。
- 所有新依赖通过 `pnpm audit`、许可证扫描、Next SSR/客户端 bundle 构建和键盘/屏幕阅读器回归；大型库必须路由级动态 import，并检查首屏 bundle。

## 最终建议

V1 最小组合是：**自建 Tailwind primitives + TanStack Table + Recharts + react-day-picker/date-fns + cmdk + 自建邮件/Timeline**。保留现有 XYFlow 仅用于 workflow canvas。`react-pdf` 与 MapLibre 属于有明确业务事实后再开的 P1 能力；这样能覆盖 Navisight 对齐页面，同时把安全、许可证、地图服务费和 bundle 风险控制在可审计范围内。
