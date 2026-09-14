# AI-generated architecture images

Generated with the built-in image generation tool. These PNGs show logical responsibilities, not exact deployment topology. Vendor choices remain in the README implementation table. The legacy Draw.io files are a separate older technical diagram, not the source of these images.

## Chinese image prompt

Use case: infographic-diagram. Generate a polished high-resolution landscape software architecture image for the SupplySentry GitHub README. Crisp typography, generous whitespace, very clear reading order, flat professional editorial tech design, white background, navy text, restrained blue core, amber integrations, sage storage. No 3D, no mascots, no brand/vendor logos. Abstract stable responsibilities: never mention implementation vendor names. Layout four horizontal bands with generous padding. Top workspace band, large central runtime band, integration band, persistence foundation. Runtime has a slim workflow engine bar then FOUR numbered cards with left-to-right arrows: evidence -> AI proposals -> policy/human approval -> controlled execution. Under these cards a dashed return arrow from execution to evidence marked verified receipts. This is logical architecture, not a deployment diagram. No other ambiguous arrows; lower integration and storage bands are shared capabilities, not sequential workflow steps. Text must be large, precisely legible, no overlaps or clipping, concise, no invented claims. ALL visible text in Simplified Chinese except SupplySentry, AI, ERP and API. Title "SupplySentry 系统架构"; subtitle "证据驱动的采购执行 · 稳定职责，可替换实现".
Band 1 heading "业务工作台", content "订单 · 供应商 · 交付风险 · 催单 · 审批 · 单证", right small module "业务接口与权限".
Band 2 heading "采购智能体运行时", prominent principle "模型提出建议，业务规则决定执行". Workflow bar "持久化工作流引擎" with subtext "状态持久化 · 定时重试 · 审批等待 · 故障恢复".
Four cards exact titles and subtexts:
"01 证据上下文" / "关联订单与供应商" / "保留来源与版本";
"02 AI 解析与建议" / "提取数量与交期" / "保留模糊与不确定性";
"03 策略与人工审批" / "字段校验与差异检查" / "重大变更人工确认";
"04 受控执行网关" / "权限 · 版本 · 幂等" / "仅执行已批准指令".
Dashed feedback label "核验回执 → 更新订单、风险与审计".
Band 3 heading "可替换集成层", three equal modules "消息渠道适配器" / "消息收发与回执", "企业系统连接器" / "ERP、仓储与读回核验", "工具接口" / "API 与受控业务工具".
Band 4 heading "共享持久化层", three equal modules "业务状态" / "订单与供应商", "证据与审计" / "原始消息与执行记录", "工作流状态" / "历史、等待与恢复点".
Small footer "逻辑架构：模型、渠道、工作流引擎与存储实现均可替换" and second footer "公开演示使用合成数据与模拟模型，不向外部发送消息".

## English localization prompt

Reference: `supplysentry-architecture.zh-CN.png`.

Use case: text-localization. Create the English edition of this SupplySentry architecture image. Preserve the same four-band layout, flat icons, white background, navy blue typography, blue runtime, amber integrations, sage persistence, arrows and proportions. Replace ALL Chinese text with clear concise English. Adjust font size and wrapping to avoid overflow. High-resolution professional README architecture infographic. Exact replacement content:
Title "SupplySentry Architecture". Subtitle "Evidence-driven procurement · Stable roles, replaceable implementations".
Top left "Business Workspace", middle "Orders · Suppliers · Delivery Risk · Follow-ups · Approvals · Documents", right "APIs & Access Control".
Runtime heading "Procurement Agent Runtime"; principle "Model proposes. Business rules decide."
Workflow bar "Durable Workflow Engine"; subtext "Persistent state · Timers & retries · Approval waits · Recovery".
Four cards:
"01 Evidence Context" / "Link orders & suppliers" / "Preserve sources & versions";
"02 AI Fact Proposals" / "Extract quantities & dates" / "Keep uncertainty explicit";
"03 Policy & Approval" / "Validate fields & changes" / "Human review for major changes";
"04 Action Gateway" / "Permissions · Versions · Idempotency" / "Approved commands only".
Dashed feedback label "Verified receipts update orders, risk & audit".
Amber left "Replaceable Integrations"; modules "Messaging Adapters" / "Messages & channel receipts", "Enterprise Connectors" / "ERP, warehouse & readback", "Tool Interface" / "APIs & controlled business tools".
Green left "Shared Persistence"; modules "Business State" / "Orders & suppliers", "Evidence & Audit" / "Source messages & action records", "Workflow State" / "History, waits & recovery points".
Bottom footnotes "Logical view: model, channel, workflow and storage implementations are replaceable." and "Public demo: synthetic data and mock model; no external messages."
No Chinese remaining, no vendor logos, no implementation-specific brands.
