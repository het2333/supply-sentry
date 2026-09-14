# Agent system design image

AI-generated raster illustration created with the built-in image generation tool, using the user-provided hand-drawn graph-paper diagram as a style reference only. The reference is not included in the repository. No Draw.io generation was used.

## Scope and review

- Logical execution view, not a LangGraph graph or physical service topology.
- Current implementation: Temporal durable workflows, typed AI proposals, policy/human approval and a controlled Action Gateway.
- Approved actions still require current permission, version and idempotency checks.
- Unknown external outcomes require reconciliation, not blind resending.
- Public-demo external actions are simulated.
- The image was visually reviewed for labels, branch directions, approval gating and uncertain-result handling. The dashed-line legend primarily describes recovery; the labeled uncertain-result branch is also dashed.

## Generation prompt

Use case: infographic-diagram. Create ONE new Chinese educational Agent system design diagram for SupplySentry, using the attached image ONLY as a STYLE REFERENCE, not a content template. Match its pale blue square graph-paper background, dark navy handwritten-marker titles, clean navy outlined doodle icons, pastel yellow/blue/pink/mint rounded node boxes, black solid arrows and dashed blue support/recovery lines, light-blue marker underlines and marginal handwritten notes. Wide landscape 16:9, high resolution, extremely legible Chinese text, generous whitespace. This is a real procurement Agent, NOT LangGraph; do not use LangGraph, Checkpoint or invented framework names. No vendor names, no model logos, no 3D.
Title at top "SupplySentry 采购 Agent 系统设计".
Subtitle under blue marker underline "AI 理解证据，业务规则控制执行".
A slim left legend panel (15% width) title "图例": document icon "任务处理" yellow, branching icon "规则判断" blue, person icon "人工介入" pink, checkmark icon "结果核验" mint; black arrow "业务流转"; dashed blue line "持久化与恢复". Keep legend compact, not competing with main flow.

Main canvas occupies remaining 80% width. Central readable left-to-right flow with exactly these five aligned nodes:
1 yellow document "供应商消息" smaller "邮件 / 消息渠道"
2 blue database "证据上下文" smaller "关联订单 · 保留原文"
3 yellow lightbulb "AI 提取建议" smaller "数量 · 交期 · 不确定性"
4 blue branching icon "规则校验" smaller "字段 · 差异 · 风险"
5 yellow shield/tool "受控执行" smaller "权限 · 版本 · 幂等".
Solid black arrows 1→2→3→4. From 4 to 5 a solid arrow above/between boxes labeled "策略允许". Below 4 a pink human node "人工审批", arrow from 4 downward labeled "重大差异"; arrow from this human node to node 5 labeled "批准后重新校验". Put a small pink note near human node "拒绝：停止本次动作", not connected to execution.
Next row to the right, below execution with sufficient spacing: a mint checkmark node "回执核验" smaller "核对外部执行结果". Arrow downward from controlled execution to this node. From this mint node to the right or bottom-right a blue finished node "更新业务状态" smaller "订单 · 风险 · 通知 · 审计", arrow labeled "已确认".
Separate small pink node left of receipt check "人工核对" smaller "结果不确定，禁止盲目重发", reached ONLY by a dashed blue arrow FROM receipt check labeled "不确定"; it must NOT loop automatically back to execution.
Above main row a blue or pink wide persistence module titled "持久化工作流" smaller "保存进度 · 审批等待 · 定时重试 · 故障恢复". Dashed blue supportive connectors from this module to evidence context and human approval, routed in whitespace, must not run through any node.
Bottom handwritten blue notes with blue marker underline: left "模糊回复保留不确定性，不编造承诺"; right "中断后恢复进度，不重复执行外部动作".
Very small footer "逻辑设计图 · 底层模型、消息渠道与存储可替换". Second small footer "公开 Demo 使用合成数据与模拟模型，对外动作仅模拟".
PRIORITIES: accurate arrow directions and safety boundaries, beautiful clean handwritten graph-paper style, verbatim Chinese without typos, visual clarity. Do not add extra nodes or unexplained arrows. Keep titles large, limit details to specified short captions.
