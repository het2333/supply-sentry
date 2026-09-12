import type { DatabaseSync } from 'node:sqlite';
import type {
  NodeTypeDescriptor,
  WorkflowEdgeDefinition,
  WorkflowNodeDefinition,
  WorkflowNodeKind,
  WorkflowRunMode,
} from '@readywork/graph-runtime';
import { PROCUREMENT_EMPLOYEE_PACK, PROCUREMENT_NODE_ASSETS, inferProcurementNodeDescriptor } from '@readywork/supply-chain';
import type { ProcurementNodeAsset } from '@readywork/supply-chain';
import { initializeControlPlaneSchema } from '@readywork/persistence';

export type EditorNodeKind = WorkflowNodeKind;
export type EditorRunMode = WorkflowRunMode;
export type EditorNodeDef = WorkflowNodeDefinition;
export type EditorEdgeDef = WorkflowEdgeDefinition;

export interface EditorWorkflowDef {
  id: string;
  name: string;
  desc: string;
  nodes: EditorNodeDef[];
  edges: EditorEdgeDef[];
  draftRevision: number;
  publishedRevision: number;
  publishedVersion: string;
  updatedAt: string;
}

/**
 * 旧版总额三单匹配草稿的显式升级预览。
 *
 * API：GET /api/editor/workflows/:id/invoice-match-upgrade 获取预览；
 * POST 同一路径并提交 { confirm: true, expectedRevision } 执行升级。
 */
export interface InvoiceMatchUpgradePreview {
  status: 'eligible' | 'already_current' | 'not_applicable';
  workflowId: string;
  currentRevision: number;
  reason: string;
  changedNodeIds: string[];
  addedNodeIds: string[];
  removedEdgeIds: string[];
  addedEdges: Array<Pick<EditorEdgeDef, 'from' | 'to' | 'label'>>;
}

export interface InvoiceMatchUpgradeResult {
  status: 'upgraded' | 'already_current' | 'not_applicable';
  preview: InvoiceMatchUpgradePreview;
  workflow: EditorWorkflowDef;
}

export interface EditorBlueprintWorkflowDiff {
  workflowId: string;
  workflowName: string;
  status: 'current' | 'replace';
  currentRevision: number;
  currentNodeCount: number;
  blueprintNodeCount: number;
  currentEdgeCount: number;
  blueprintEdgeCount: number;
  addedNodeIds: string[];
  removedNodeIds: string[];
  changedNodeIds: string[];
  addedEdgeIds: string[];
  removedEdgeIds: string[];
  changedEdgeIds: string[];
  metadataChanged: boolean;
}

/**
 * 当前租户草稿与已安装 Employee Pack 默认蓝图之间的只读差异。
 * 导入必须再次提交这里返回的 expectedRevisions，避免覆盖并发编辑。
 */
export interface EditorBlueprintUpgradePreview {
  status: 'current' | 'upgrade_available';
  packId: string;
  packVersion: string;
  reason: string;
  expectedRevisions: Record<string, number>;
  workflows: EditorBlueprintWorkflowDiff[];
  replacesExistingDrafts: boolean;
  createsBackup: true;
}

export interface EditorBlueprintUpgradeResult {
  status: 'imported' | 'already_current' | 'replayed';
  importId: string | null;
  packId: string;
  packVersion: string;
  createdAt: string | null;
  preview: EditorBlueprintUpgradePreview;
  workflows: EditorWorkflowDef[];
}

export interface EditorLibraryGroup {
  group: string;
  items: Array<{
    id: string;
    label: string;
    desc: string;
    kind: EditorNodeKind;
    type: string;
    typeVersion: number;
    icon: string;
    inputs: NodeTypeDescriptor['inputs'];
    outputs: NodeTypeDescriptor['outputs'];
    parameters: NodeTypeDescriptor['parameters'];
    credentials: NodeTypeDescriptor['credentials'];
    runtime: NodeTypeDescriptor['runtime'];
    executor: string;
    sideEffects: string[];
  }>;
}

/** 领域能力包只提供资产与默认蓝图，控制面存储和执行保持通用。 */
export interface EditorCapabilityPack {
  id: string;
  name: string;
  initialVersion: string;
  workflowIds: string[];
  groups: EditorLibraryGroup[];
  nodeTypes: NodeTypeDescriptor[];
  defaultWorkflows(): EditorWorkflowDef[];
  inferNodeDescriptor(label: string, kind: EditorNodeKind): NodeTypeDescriptor;
}

export interface EditorVersion {
  id: string;
  version: string;
  status: 'published';
  current: boolean;
  note: string;
  createdAt: string;
  workflowCount: number;
  tenantId?: string;
  employeeId?: string;
  ruleSetVersion?: string;
}

export interface EditorRun {
  id: string;
  workflowId: string;
  workflowName: string;
  mode: EditorRunMode;
  status: 'queued' | 'running' | 'completed' | 'waiting_approval' | 'waiting_external' | 'ready' | 'rejected' | 'failed' | 'cancelled';
  decision: Record<string, unknown>;
  sideEffects: 'blocked' | 'approval_gate' | 'enabled';
  message: string;
  createdAt: string;
  updatedAt?: string;
  tenantId?: string;
  employeeId?: string;
  workflowVersionId?: string;
  workflowVersion?: string;
  temporalWorkflowId?: string;
  temporalRunId?: string;
  runtime?: 'temporal' | 'legacy';
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  nodeCount?: number;
  idempotencyKey?: string;
}

export interface EditorNodeRun {
  id: string;
  tenantId: string;
  runId: string;
  nodeId: string;
  nodeLabel: string;
  nodeKind: EditorNodeKind;
  status: 'running' | 'completed' | 'blocked' | 'failed';
  attempt: number;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  sideEffectStatus: 'none' | 'blocked' | 'approval_gate' | 'executed';
  message?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface EditorRuleSet {
  id: string;
  tenantId: string;
  employeeId: string;
  version: string;
  status: 'published';
  current: boolean;
  thresholds: Record<string, { auto: number; buyer: number }>;
  createdAt: string;
}

export interface EditorBusinessActivity {
  id: string;
  tenantId: string;
  runId: string;
  nodeRunId: string;
  type: string;
  title: string;
  summary: string;
  objectId?: string;
  createdAt: string;
}

export class EditorRevisionRequiredError extends Error {
  constructor() {
    super('保存工作流必须提供 expectedRevision');
    this.name = 'EditorRevisionRequiredError';
  }
}

export class EditorRevisionConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly currentRevision: number) {
    super(`工作流版本冲突：期望 r${expectedRevision}，当前为 r${currentRevision}`);
    this.name = 'EditorRevisionConflictError';
  }
}

export class EditorIdempotencyConflictError extends Error {
  constructor() {
    super('幂等键已用于不同的蓝图导入请求');
    this.name = 'EditorIdempotencyConflictError';
  }
}

const node = (id: string, kind: EditorNodeKind, label: string, detail: string, extra: Partial<EditorNodeDef> = {}): EditorNodeDef => {
  const nodeDescriptor = inferProcurementNodeDescriptor(label, kind);
  const parameters = extra.parameters ?? Object.fromEntries(
    nodeDescriptor.parameters
      .filter((parameter) => parameter.defaultValue !== undefined)
      .map((parameter) => [parameter.id, parameter.defaultValue!]),
  );
  return {
    id,
    kind,
    label,
    detail,
    name: extra.name ?? label,
    type: extra.type ?? nodeDescriptor.type,
    typeVersion: extra.typeVersion ?? nodeDescriptor.version,
    icon: extra.icon ?? nodeDescriptor.icon,
    config: extra.config ?? parameters,
    parameters,
    sideEffects: extra.sideEffects ?? nodeDescriptor.sideEffects,
    ...extra,
  };
};
const edge = (from: string, to: string, label?: string): EditorEdgeDef => ({ from, to, ...(label ? { label } : {}) });

function libraryFromAssets(assets: ProcurementNodeAsset[]): EditorLibraryGroup[] {
  return ['触发器', 'AI能力', '业务逻辑', '工具'].map((group) => ({
  group,
  items: assets
    .filter((item) => item.group === group)
    .map((item) => ({
      id: item.assetId,
      label: item.descriptor.name,
      desc: item.descriptor.description,
      kind: item.kind,
      type: item.descriptor.type,
      typeVersion: item.descriptor.version,
      icon: item.descriptor.icon,
      inputs: item.descriptor.inputs,
      outputs: item.descriptor.outputs,
      parameters: item.descriptor.parameters,
      credentials: item.descriptor.credentials,
      runtime: item.descriptor.runtime,
      executor: item.descriptor.executor,
      sideEffects: item.descriptor.sideEffects ?? [],
    })),
  }));
}

export const EDITOR_LIBRARY: EditorLibraryGroup[] = libraryFromAssets(PROCUREMENT_NODE_ASSETS);

const delayRules: EditorNodeDef['rules'] = [
  { cond: '延期 ≤ 2 天', action: '自动接受', level: 'auto' },
  { cond: '延期 3–5 天', action: '采购员审批', level: 'buyer' },
  { cond: '延期 > 5 天', action: '采购经理审批', level: 'manager' },
];

const threeWayRules: EditorNodeDef['rules'] = [
  { cond: '差异 ≤ 1%', action: '自动通过', level: 'auto' },
  { cond: '差异 1–3%', action: '财务审批', level: 'finance' },
  { cond: '差异 > 3%', action: '采购+财务审批', level: 'manager' },
];

function editorLayout(nodes: EditorNodeDef[], edges: EditorEdgeDef[]): EditorNodeDef[] {
  const incoming = new Map(nodes.map((item) => [item.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const item of edges) {
    incoming.set(item.to, (incoming.get(item.to) ?? 0) + 1);
    outgoing.set(item.from, [...(outgoing.get(item.from) ?? []), item.to]);
  }
  const layer = new Map<string, number>();
  const queue = nodes.filter((item) => (incoming.get(item.id) ?? 0) === 0).map((item) => item.id);
  if (queue.length === 0 && nodes[0]) queue.push(nodes[0].id);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentLayer = layer.get(current) ?? 0;
    for (const target of outgoing.get(current) ?? []) {
      layer.set(target, Math.max(layer.get(target) ?? 0, currentLayer + 1));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  for (const item of nodes) if (!layer.has(item.id)) layer.set(item.id, 0);
  const grouped = new Map<number, EditorNodeDef[]>();
  for (const item of nodes) {
    const nodeLayer = layer.get(item.id) ?? 0;
    grouped.set(nodeLayer, [...(grouped.get(nodeLayer) ?? []), item]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [nodeLayer, group] of grouped) {
    const totalHeight = Math.max(0, (group.length - 1) * 164);
    group.forEach((item, index) => positions.set(item.id, { x: 56 + nodeLayer * 310, y: 256 + index * 164 - totalHeight / 2 }));
  }
  return nodes.map((item) => ({ ...item, position: item.position ?? positions.get(item.id) ?? { x: 56, y: 256 } }));
}

function ensureEditorMetadata(workflow: EditorWorkflowDef): { workflow: EditorWorkflowDef; changed: boolean } {
  let changed = false;
  const nodes = editorLayout(workflow.nodes, workflow.edges).map((item, index) => {
    const original = workflow.nodes[index]!;
    if (!original.position || !Number.isFinite(original.position.x) || !Number.isFinite(original.position.y)) changed = true;
    return item;
  });
  const usedEdgeIds = new Set<string>();
  const edges = workflow.edges.map((item, index) => {
    let id = item.id;
    if (!id || usedEdgeIds.has(id)) {
      id = `edge:${workflow.id}:${index + 1}`;
      while (usedEdgeIds.has(id)) id = `${id}:next`;
      changed = true;
    }
    usedEdgeIds.add(id);
    return { ...item, id };
  });
  return { workflow: { ...workflow, nodes, edges }, changed };
}

function seedWorkflow(
  input: Omit<EditorWorkflowDef, 'draftRevision' | 'publishedRevision' | 'publishedVersion' | 'updatedAt'>,
  publishedVersion = 'v0.4.0',
): EditorWorkflowDef {
  return ensureEditorMetadata({ ...input, draftRevision: 1, publishedRevision: 1, publishedVersion, updatedAt: new Date().toISOString() }).workflow;
}

function invoiceMatchDefaultWorkflow(): EditorWorkflowDef {
  return seedWorkflow({
    id: 'invoice-match', name: '发票与三单匹配', desc: '发票识别、PO/收货关联、三单匹配、差异审批与应付登记。',
    nodes: [node('t:inv', 'trigger', '发票事件', '供应商发票到达'), node('ai:inv', 'ai', '发票识别', '提取金额与关联 PO'), node('logic:link', 'logic', '关联 PO / 收货', '找到对应采购单与收货单'), deterministicLineMatchNode('match:line'), node('appr:tw', 'approval', '财务审批', '需要审批的匹配差异提交财务审批，批准后从断点恢复', { permission: 'finance' }), payableMarkNode('x:pay'), erpPayWriteNode('erp:pay'), severeExceptionNode('x:exception'), node('n:inv', 'action', '核对结果通知', '通知采购与财务')],
    edges: [edge('t:inv', 'ai:inv'), edge('ai:inv', 'logic:link'), edge('logic:link', 'match:line'), ...deterministicLineMatchEdges({ lineMatch: 'match:line', approval: 'appr:tw', payable: 'x:pay', erpWrite: 'erp:pay', severeException: 'x:exception', notification: 'n:inv' })],
  }, 'v0.4.0');
}

function deterministicLineMatchNode(id: string, extra: Partial<EditorNodeDef> = {}): EditorNodeDef {
  return node(id, 'action', '行级三单匹配', '基于 PO 行、收货行、发票行和历史分配进行确定性匹配', extra);
}

function payableMarkNode(id: string): EditorNodeDef {
  return node(id, 'action', '应付审核/登记', '应付审核完成/标记可付款');
}

function erpPayWriteNode(id: string): EditorNodeDef {
  return node(id, 'tool', 'ERP回写应付结果', '将已审核的应付结果回写 ERP', { parameters: { action: 'invoice.update' }, sideEffects: ['写 ERP'] });
}

function severeExceptionNode(id: string): EditorNodeDef {
  return node(id, 'action', '三单匹配异常处理', '严重异常进入异常工作台，等待人工处理');
}

function deterministicLineMatchEdges(ids: { lineMatch: string; approval: string; payable: string; erpWrite: string; severeException: string; notification: string }): EditorEdgeDef[] {
  return [
    edge(ids.lineMatch, ids.payable, '完全匹配'),
    edge(ids.lineMatch, ids.payable, '容差内'),
    edge(ids.lineMatch, ids.approval, '需要审批'),
    edge(ids.approval, ids.payable, '批准后恢复'),
    edge(ids.lineMatch, ids.severeException, '严重异常'),
    edge(ids.payable, ids.erpWrite),
    edge(ids.erpWrite, ids.notification),
    edge(ids.severeException, ids.notification),
  ];
}

/**
 * 仅用于读取和升级 1.0 之前保存的采购草稿。生产目录不再把这些旧流程
 * 作为 Navisight V1 的新建能力暴露。
 */
export function legacyEditorWorkflows(): EditorWorkflowDef[] {
  return [
    seedWorkflow({
      id: 'procurement-orchestrator', name: '采购路径编排', desc: '一个事件进来，按 PO、发票、合同价和收货状态动态选路。',
      nodes: [
        node('trig:erp', 'trigger', 'ERP新事件', '采购域事件进入员工入口', { inputs: ['事件类型', '业务对象'], outputs: ['事件事实快照'] }),
        node('router:path', 'router', '采购路径判断', '按当前业务状态决定只跑需要的分支', { inputs: ['hasPo', 'hasInvoice', 'hasReceipt', 'hasContractPrice'], outputs: ['路径决策'], failAction: '创建系统异常', permission: 'auto' }),
        node('rfq:run', 'action', 'RFQ询价', '询价、比价与定标', { inputs: ['采购需求'], outputs: ['中标供应商'], retries: 2, failAction: '转异常工作台' }),
        node('po:exec', 'action', 'PO执行', '订单确认、交期、催交与到货', { inputs: ['poId'], outputs: ['交期更新', '到货状态'], retries: 2 }),
        node('inv:match', 'action', '发票处理', '识别、关联、三单匹配与应付', { inputs: ['invoiceId'], outputs: ['应付建议'], retries: 2 }),
        node('recv:wait', 'logic', '等待收货', '发票已到但货未到，收货后自动重新匹配', { timeoutMs: 432000000, inputs: ['poId'], outputs: ['收货事件'] }),
        node('rfq:back', 'router', '返回询价', '供应商拒单后回退重新定标'),
        node('ai:delay', 'ai', '交期异常判断', '计算延期天数并按权限分级', { inputs: ['原承诺交期', '新承诺交期', '库存覆盖', '生产需求'], outputs: ['延期天数', '审批级别'], rules: delayRules }),
        node('ai:threeway', 'ai', '三单匹配（旧版）', '旧版总额三单核对预览；新流程请使用确定性的行级三单匹配节点。', { inputs: ['poAmount', 'invoiceAmount', 'receiptQty'], outputs: ['差异率'], rules: threeWayRules }),
        node('ai:quote', 'ai', '比价推荐', '按报价、交期与准时率综合评分'),
        node('appr:uni', 'approval', '统一审批', '超出权限时挂起，批准后从断点恢复', { inputs: ['异常对象', 'AI建议'], outputs: ['审批决定'], permission: 'manager', failAction: '挂起等待人工' }),
        node('erp:write', 'tool', 'ERP回写', '更新交期、落标或应付台账', { retries: 3, failAction: '创建系统异常', sideEffects: ['写 ERP'] }),
      ],
      edges: [
        edge('trig:erp', 'router:path'), edge('router:path', 'rfq:run', '无有效价格'), edge('router:path', 'po:exec', '已有 PO'), edge('router:path', 'inv:match', '发票已到'), edge('router:path', 'recv:wait', '发票到、货未到'), edge('router:path', 'rfq:back', '供应商拒单'), edge('recv:wait', 'inv:match', '收货后重匹配'), edge('rfq:back', 'rfq:run', '重新定标'), edge('po:exec', 'ai:delay'), edge('inv:match', 'ai:threeway'), edge('rfq:run', 'ai:quote'), edge('ai:delay', 'appr:uni', '超权限'), edge('ai:threeway', 'appr:uni', '差异超限'), edge('ai:quote', 'appr:uni', '金额超限'), edge('appr:uni', 'erp:write', '批准后恢复'),
      ],
    }),
    seedWorkflow({
      id: 'rfq-process', name: '询价与报价', desc: '从采购需求到询价、报价解析、比价推荐与定标。',
      nodes: [
        node('t:rfq', 'trigger', '询价单创建', '采购需求进入询价'), node('m:ask', 'tool', '邮件询价', '向候选供应商发询价邀请', { retries: 2, sideEffects: ['发邮件'] }), node('w:quote', 'logic', '等待报价', '等待供应商回复', { timeoutMs: 259200000 }), node('ai:collect', 'ai', '报价收集', '汇总各家报价'), node('ai:parse', 'ai', '报价解析', '提取单价、交期与规格'), node('ai:reco', 'ai', '比价推荐', '综合评分推荐中标供应商'), node('appr:rfq', 'approval', '中标审批', '超出金额权限时由采购经理审批', { permission: 'manager' }), node('a:award', 'tool', 'ERP落单', '回写中标结果', { retries: 3, sideEffects: ['写 ERP'] }),
      ],
      edges: [edge('t:rfq', 'm:ask'), edge('m:ask', 'w:quote'), edge('w:quote', 'ai:collect'), edge('ai:collect', 'ai:parse'), edge('ai:parse', 'ai:reco'), edge('ai:reco', 'appr:rfq'), edge('appr:rfq', 'a:award')],
    }),
    seedWorkflow({
      id: 'po-operations', name: '采购订单执行', desc: '从 PO 已真实发出开始，推进供应商承诺、生产、发运和到货交接。',
      nodes: [
        node('t:po', 'trigger', '采购订单发出', '只有邮件或 ERP 连接器已返回真实成功，PO 才进入执行'),
        node('w:confirm', 'logic', '等待供应商确认', '持久化等待供应商对价格、数量和交期的确认', { parameters: { eventType: 'supplier_commitment', timeoutMs: 259200000 } }),
        node('ai:reply', 'ai', '回复解析', '提取供应商确认、拒绝或差异事实'),
        node('ai:eta', 'ai', '交期提取', '提取最新承诺交期'),
        node('logic:delay', 'logic', '交期异常判断', '比较 PO 基线与供应商承诺并按权限分级', { rules: delayRules }),
        node('appr:delay', 'approval', '延期审批', '价格、数量或交期差异超出权限时等待人工决定', { permission: 'manager' }),
        node('t:update', 'tool', 'ERP更新交期', '把已批准的供应商承诺回写 ERP', { parameters: { action: 'po.update' }, retries: 3, sideEffects: ['写 ERP'] }),
        node('w:production', 'logic', '等待生产进度', '等待供应商生产进度或超时事件', { parameters: { eventType: 'production_progress', timeoutMs: 259200000 } }),
        node('logic:production-risk', 'logic', '生产风险判断', '判断生产进度是否偏离承诺'),
        node('ai:follow', 'ai', '催交沟通', '基于 PO 和生产事实生成催交内容'),
        node('mail:follow', 'tool', '发送供应商邮件', '通过企业邮箱发送已批准的催交内容', { retries: 3, sideEffects: ['发送外部邮件'] }),
        node('w:production-update', 'logic', '等待更新进度', '催交后等待新的生产进度', { parameters: { eventType: 'production_progress', timeoutMs: 259200000 } }),
        node('w:dispatch', 'logic', '等待发运', '等待部分或全部发运事实', { parameters: { eventType: 'shipment_dispatched', timeoutMs: 259200000 } }),
        node('a:transit', 'action', '运输跟踪', '记录发运数量、在途节点与预计到货'),
        node('w:goods', 'logic', '等待到货', '等待仓库部分或全部收货事实', { parameters: { eventType: 'goods_received', timeoutMs: 259200000 } }),
        node('a:handoff', 'action', '转交收货流程', '携带 PO、发运和收货证据进入最终 GRN 核验'),
      ],
      edges: [
        edge('t:po', 'w:confirm'), edge('w:confirm', 'ai:reply'), edge('ai:reply', 'ai:eta'), edge('ai:eta', 'logic:delay'),
        edge('logic:delay', 't:update', '自动接受'), edge('logic:delay', 'appr:delay', '需审批'), edge('appr:delay', 't:update', '批准后恢复'),
        edge('t:update', 'w:production'), edge('w:production', 'logic:production-risk'), edge('logic:production-risk', 'w:dispatch', '进度正常'),
        edge('logic:production-risk', 'ai:follow', '存在风险'), edge('ai:follow', 'mail:follow'), edge('mail:follow', 'w:production-update'),
        edge('w:production-update', 'w:dispatch'), edge('w:dispatch', 'a:transit'), edge('a:transit', 'w:goods'), edge('w:goods', 'a:handoff'),
      ],
    }),
    seedWorkflow({
      id: 'supplier-followup', name: '供应商催交', desc: '按 SLA 检查未确认或生产延期事项，真实发信后等待回复并更新承诺。',
      nodes: [
        node('t:delay', 'trigger', '定时任务', '按已发布 SLA 扫描未确认和生产延期的 PO'),
        node('logic:overdue', 'logic', '条件', '只有达到催交阈值的 PO 才进入外部沟通'),
        node('ai:push', 'ai', '催交沟通', '基于真实 PO、历史邮件和 SLA 生成催交草稿'),
        node('mail:push', 'tool', '发送供应商邮件', '通过已配置企业邮箱发送催交邮件', { retries: 3, sideEffects: ['发送外部邮件'] }),
        node('w:reply', 'logic', '等待供应商回复', '持久化等待答复或超时', { parameters: { eventType: 'supplier_reply', timeoutMs: 259200000 } }),
        node('ai:reply', 'ai', '回复解析', '提取供应商最新承诺与差异'),
        node('ai:neweta', 'ai', '交期提取', '解析新承诺交期'),
        node('logic:followup-risk', 'logic', '交期异常判断', '按授权阈值判断能否自动接受', { rules: delayRules }),
        node('appr:followup', 'approval', '延期审批', '超权限的新承诺等待采购经理决定', { permission: 'manager' }),
        node('t:upd2', 'tool', 'ERP更新交期', '回写已接受的新承诺', { parameters: { action: 'po.update' }, retries: 3, sideEffects: ['写 ERP'] }),
        node('n:notify', 'action', '通知采购员', '记录最新承诺和催交结果'),
        node('a:skip', 'action', '保持观察', '尚未达到催交阈值，不产生外部副作用'),
      ],
      edges: [
        edge('t:delay', 'logic:overdue'), edge('logic:overdue', 'ai:push', '达到阈值'), edge('logic:overdue', 'a:skip', '未到阈值'),
        edge('ai:push', 'mail:push'), edge('mail:push', 'w:reply'), edge('w:reply', 'ai:reply'), edge('ai:reply', 'ai:neweta'),
        edge('ai:neweta', 'logic:followup-risk'), edge('logic:followup-risk', 't:upd2', '自动接受'), edge('logic:followup-risk', 'appr:followup', '需审批'),
        edge('appr:followup', 't:upd2', '批准后恢复'), edge('t:upd2', 'n:notify'),
      ],
    }),
    seedWorkflow({
      id: 'delivery-receipt', name: '交付与收货', desc: '处理部分/全部收货，累计数量并只在最终真实 GRN 后关闭执行链。',
      nodes: [
        node('t:arrive', 'trigger', '到货事件', '接收 Odoo 或 WMS 的真实收货事实'),
        node('ai:check', 'ai', '订单核对', '核对 PO 行、发运行和本次收货行'),
        node('logic:qty', 'logic', '数量核对', '判断本次收货后是部分收货还是全部收货'),
        node('a:partial-store', 'tool', 'WMS部分入库', '登记本次部分收货', { retries: 2, sideEffects: ['写 WMS'] }),
        node('erp:partial', 'tool', 'ERP更新收货进度', '累计部分收货数量但不关闭 PO', { parameters: { action: 'po.update' }, retries: 3, sideEffects: ['写 ERP'] }),
        node('w:final', 'logic', '等待最终收货', '继续等待剩余数量到货', { parameters: { eventType: 'goods_received', timeoutMs: 259200000 } }),
        node('a:final-store', 'tool', 'WMS最终入库', '登记全部剩余收货并取得 GRN', { retries: 2, sideEffects: ['写 WMS'] }),
        node('erp:grn', 'tool', 'ERP回写最终GRN', '把最终 GRN 和累计实收数量回写 ERP', { parameters: { action: 'po.update' }, retries: 3, sideEffects: ['写 ERP'] }),
        node('n:recv', 'action', '完成执行闭环', '只有最终 GRN 证据完整后才关闭 PO 执行任务'),
      ],
      edges: [
        edge('t:arrive', 'ai:check'), edge('ai:check', 'logic:qty'), edge('logic:qty', 'a:partial-store', '部分收货'),
        edge('a:partial-store', 'erp:partial'), edge('erp:partial', 'w:final'), edge('w:final', 'a:final-store'),
        edge('logic:qty', 'a:final-store', '全部收货'), edge('a:final-store', 'erp:grn'), edge('erp:grn', 'n:recv'),
      ],
    }),
    invoiceMatchDefaultWorkflow(),
  ];
}

/** Navisight V1 只拥有 PO 发出到最终 GRN 的三条 post-PO 流程。 */
export function defaultEditorWorkflows(): EditorWorkflowDef[] {
  const activeIds = new Set(PROCUREMENT_EMPLOYEE_PACK.assets.workflowIds);
  return legacyEditorWorkflows()
    .filter((workflow) => activeIds.has(workflow.id))
    .map((workflow) => ({ ...workflow, publishedVersion: 'v1.0.0' }));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'undefined' : serialized;
}

function byId<T extends { id?: string }>(items: T[], prefix: string): Map<string, T> {
  return new Map(items.map((item, index) => [item.id || `${prefix}:${index + 1}`, item]));
}

function blueprintWorkflowDiff(current: EditorWorkflowDef, blueprint: EditorWorkflowDef): EditorBlueprintWorkflowDiff {
  const currentNodes = byId(current.nodes, 'current-node');
  const blueprintNodes = byId(blueprint.nodes, 'blueprint-node');
  const currentEdges = byId(current.edges, 'current-edge');
  const blueprintEdges = byId(blueprint.edges, 'blueprint-edge');
  const addedNodeIds = [...blueprintNodes.keys()].filter((id) => !currentNodes.has(id));
  const removedNodeIds = [...currentNodes.keys()].filter((id) => !blueprintNodes.has(id));
  const changedNodeIds = [...blueprintNodes.keys()].filter((id) => currentNodes.has(id) && stableJson(currentNodes.get(id)) !== stableJson(blueprintNodes.get(id)));
  const addedEdgeIds = [...blueprintEdges.keys()].filter((id) => !currentEdges.has(id));
  const removedEdgeIds = [...currentEdges.keys()].filter((id) => !blueprintEdges.has(id));
  const changedEdgeIds = [...blueprintEdges.keys()].filter((id) => currentEdges.has(id) && stableJson(currentEdges.get(id)) !== stableJson(blueprintEdges.get(id)));
  const metadataChanged = current.name !== blueprint.name || current.desc !== blueprint.desc;
  const status = metadataChanged || addedNodeIds.length > 0 || removedNodeIds.length > 0 || changedNodeIds.length > 0 || addedEdgeIds.length > 0 || removedEdgeIds.length > 0 || changedEdgeIds.length > 0
    ? 'replace'
    : 'current';
  return {
    workflowId: current.id,
    workflowName: current.name,
    status,
    currentRevision: current.draftRevision,
    currentNodeCount: current.nodes.length,
    blueprintNodeCount: blueprint.nodes.length,
    currentEdgeCount: current.edges.length,
    blueprintEdgeCount: blueprint.edges.length,
    addedNodeIds,
    removedNodeIds,
    changedNodeIds,
    addedEdgeIds,
    removedEdgeIds,
    changedEdgeIds,
    metadataChanged,
  };
}

interface InvoiceMatchUpgradePlan {
  preview: InvoiceMatchUpgradePreview;
  upgradedWorkflow?: EditorWorkflowDef;
}

function nextAvailableNodeId(used: Set<string>, preferred: string): string {
  if (!used.has(preferred)) return preferred;
  let sequence = 2;
  while (used.has(`${preferred}:${sequence}`)) sequence += 1;
  return `${preferred}:${sequence}`;
}

/** 仅替换明确标识为 ai.three_way_match 的旧节点；其他用户节点和连线保持不变。 */
function invoiceMatchUpgradePlan(workflow: EditorWorkflowDef): InvoiceMatchUpgradePlan {
  const base = (status: InvoiceMatchUpgradePreview['status'], reason: string): InvoiceMatchUpgradePlan => ({
    preview: { status, workflowId: workflow.id, currentRevision: workflow.draftRevision, reason, changedNodeIds: [], addedNodeIds: [], removedEdgeIds: [], addedEdges: [] },
  });
  if (workflow.id !== 'invoice-match') return base('not_applicable', '仅支持升级 invoice-match 工作流');
  const legacyNodes = workflow.nodes.filter((item) => item.type === 'ai.three_way_match');
  if (legacyNodes.length === 0) {
    return workflow.nodes.some((item) => item.type === 'business.procurement_line_match')
      ? base('already_current', '工作流已使用确定性的行级三单匹配节点')
      : base('not_applicable', '未找到可升级的旧版 ai.three_way_match 节点');
  }
  if (legacyNodes.length !== 1 || workflow.nodes.some((item) => item.type === 'business.procurement_line_match')) {
    return base('not_applicable', '工作流包含多个或混合的三单匹配节点，无法安全自动升级');
  }

  const legacy = legacyNodes[0]!;
  const usedNodeIds = new Set(workflow.nodes.map((item) => item.id));
  const ids = {
    lineMatch: legacy.id,
    approval: nextAvailableNodeId(usedNodeIds, 'upgrade:finance-approval'),
    payable: nextAvailableNodeId(usedNodeIds, 'upgrade:payable'),
    erpWrite: nextAvailableNodeId(usedNodeIds, 'upgrade:erp-pay'),
    severeException: nextAvailableNodeId(usedNodeIds, 'upgrade:exception'),
    notification: nextAvailableNodeId(usedNodeIds, 'n:inv'),
  };
  const addedNodes = [
    node(ids.approval, 'approval', '财务审批', '需要审批的匹配差异提交财务审批，批准后从断点恢复', { permission: 'finance' }),
    payableMarkNode(ids.payable),
    erpPayWriteNode(ids.erpWrite),
    severeExceptionNode(ids.severeException),
  ];
  const notificationExists = usedNodeIds.has(ids.notification);
  if (!notificationExists) addedNodes.push(node(ids.notification, 'action', '核对结果通知', '通知采购与财务'));
  const usedEdgeIds = new Set(workflow.edges.map((item) => item.id).filter((id): id is string => Boolean(id)));
  const addedEdges = deterministicLineMatchEdges(ids).map((item, index) => ({
    ...item,
    id: nextAvailableNodeId(usedEdgeIds, `upgrade:edge:${index + 1}`),
  }));
  const removedEdges = workflow.edges.filter((item) => item.from === legacy.id);
  const upgraded: EditorWorkflowDef = {
    ...workflow,
    nodes: workflow.nodes.map((item) => item.id === legacy.id
      ? deterministicLineMatchNode(legacy.id, { position: item.position })
      : item).concat(addedNodes),
    edges: workflow.edges.filter((item) => item.from !== legacy.id).concat(addedEdges),
  };
  return {
    preview: {
      status: 'eligible', workflowId: workflow.id, currentRevision: workflow.draftRevision,
      reason: '将旧版总额三单匹配替换为行级确定性匹配，并新增财务审批、可付款标记、ERP 回写和严重异常分支。',
      changedNodeIds: [legacy.id], addedNodeIds: addedNodes.map((item) => item.id), removedEdgeIds: removedEdges.map((item) => item.id).filter((id): id is string => Boolean(id)),
      addedEdges: addedEdges.map(({ from, to, label }) => ({ from, to, label })),
    },
    upgradedWorkflow: upgraded,
  };
}

const CORE_ASSET_IDS = new Set(['t:manual', 't:mail', 'l:cond', 'l:wait', 'l:approval', 'l:parallel', 'l:business-action', 'tool:mail', 'tool:erp', 'tool:file']);
const CORE_NODE_ASSETS = PROCUREMENT_NODE_ASSETS.filter((item) => CORE_ASSET_IDS.has(item.assetId));
const NAVISIGHT_V1_NODE_TYPE_IDS = new Set(PROCUREMENT_EMPLOYEE_PACK.assets.nodeTypeIds);
const NAVISIGHT_V1_NODE_ASSETS = PROCUREMENT_NODE_ASSETS.filter((item) => NAVISIGHT_V1_NODE_TYPE_IDS.has(item.descriptor.type));

function inferFromAssets(assets: ProcurementNodeAsset[], label: string, kind: EditorNodeKind): NodeTypeDescriptor {
  const exact = assets.find((item) => item.kind === kind && (item.descriptor.name === label || label.includes(item.descriptor.name) || item.descriptor.name.includes(label)));
  const fallback = exact ?? assets.find((item) => item.kind === kind);
  if (!fallback) throw new Error(`能力包没有可用节点描述: ${kind}/${label}`);
  return fallback.descriptor;
}

function coreNode(id: string, kind: EditorNodeKind, label: string, detail: string, extra: Partial<EditorNodeDef> = {}): EditorNodeDef {
  const nodeDescriptor = inferFromAssets(CORE_NODE_ASSETS, label, kind);
  const parameters = extra.parameters ?? Object.fromEntries(
    nodeDescriptor.parameters.filter((parameter) => parameter.defaultValue !== undefined).map((parameter) => [parameter.id, parameter.defaultValue!]),
  );
  return { id, kind, label, detail, name: label, type: nodeDescriptor.type, typeVersion: nodeDescriptor.version, icon: nodeDescriptor.icon, config: parameters, parameters, sideEffects: nodeDescriptor.sideEffects, ...extra };
}

function defaultCoreWorkflows(): EditorWorkflowDef[] {
  return [seedWorkflow({
    id: 'employee-task-orchestrator',
    name: '员工任务编排',
    desc: '通用员工任务入口；安装领域能力包后可替换为专业业务流程。',
    nodes: [
      coreNode('core:manual', 'trigger', '人工触发', '从业务工作台创建一项员工任务'),
      coreNode('core:condition', 'logic', '条件', '根据任务事实选择处理路径'),
      coreNode('core:approval', 'approval', '审批', '超出员工权限时等待负责人处理'),
      coreNode('core:action', 'action', '业务动作', '记录任务结果并通知业务人员'),
    ],
    edges: [edge('core:manual', 'core:condition'), edge('core:condition', 'core:approval', 'true'), edge('core:condition', 'core:action', 'false'), edge('core:approval', 'core:action', '批准后恢复')],
  }, 'v0.1.0')];
}

export const PROCUREMENT_EDITOR_PACK: EditorCapabilityPack = {
  id: 'manufacturing.procurement',
  name: '制造业采购执行',
  initialVersion: 'v1.0.0',
  workflowIds: [...PROCUREMENT_EMPLOYEE_PACK.assets.workflowIds],
  groups: libraryFromAssets(NAVISIGHT_V1_NODE_ASSETS),
  nodeTypes: NAVISIGHT_V1_NODE_ASSETS.map((item) => item.descriptor),
  defaultWorkflows: defaultEditorWorkflows,
  inferNodeDescriptor: (label, kind) => inferFromAssets(NAVISIGHT_V1_NODE_ASSETS, label, kind),
};

export const CORE_WORKFORCE_EDITOR_PACK: EditorCapabilityPack = {
  id: 'workforce.core',
  name: '通用员工',
  initialVersion: 'v0.1.0',
  workflowIds: ['employee-task-orchestrator'],
  groups: libraryFromAssets(CORE_NODE_ASSETS),
  nodeTypes: CORE_NODE_ASSETS.map((item) => item.descriptor),
  defaultWorkflows: defaultCoreWorkflows,
  inferNodeDescriptor: (label, kind) => inferFromAssets(CORE_NODE_ASSETS, label, kind),
};

const EDITOR_SCHEMA = `
-- Legacy tables are retained for a one-time, non-destructive migration.
CREATE TABLE IF NOT EXISTS editor_workflows (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS editor_versions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS editor_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS control_workflow_drafts (
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, employee_id, workflow_id)
);
CREATE TABLE IF NOT EXISTS control_workflow_versions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL,
  rule_set_version TEXT,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, employee_id, id)
);
CREATE TABLE IF NOT EXISTS control_workflow_runs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_version_id TEXT,
  temporal_workflow_id TEXT,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  idempotency_key TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS control_node_runs (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_control_node_runs_run ON control_node_runs (tenant_id, run_id, started_at);
CREATE TABLE IF NOT EXISTS control_business_activities (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  object_id TEXT,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_control_business_activities_run ON control_business_activities (tenant_id, run_id, created_at);
CREATE TABLE IF NOT EXISTS control_rule_sets (
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 0,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, employee_id, id)
);
CREATE TABLE IF NOT EXISTS control_workflow_blueprint_imports (
  tenant_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  before_snapshot TEXT NOT NULL,
  after_snapshot TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, employee_id, idempotency_key)
);
`;

export class EditorStore {
  private workflows = new Map<string, EditorWorkflowDef>();
  private versions: Array<EditorVersion & { snapshot: EditorWorkflowDef[] }> = [];
  private runs: EditorRun[] = [];
  private blueprintImports = new Map<string, { requestFingerprint: string; result: EditorBlueprintUpgradeResult }>();

  constructor(
    private db?: DatabaseSync,
    private scope: { tenantId: string; employeeId: string } = { tenantId: 'tenant:jinggong', employeeId: 'ai:procurement' },
    private capabilityPack: EditorCapabilityPack = PROCUREMENT_EDITOR_PACK,
  ) {
    if (this.db) initializeControlPlaneSchema(this.db);
    this.migrateLegacy();
    this.repairCrossEmployeeLegacyLeak();
    this.seed();
  }

  catalog(): { groups: EditorLibraryGroup[]; nodeTypes: NodeTypeDescriptor[]; total: number; aiCapabilities: number } {
    return {
      groups: clone(this.capabilityPack.groups),
      nodeTypes: this.capabilityPack.nodeTypes.map(clone),
      total: this.capabilityPack.groups.flatMap((group) => group.items).length,
      aiCapabilities: this.capabilityPack.groups.find((group) => group.group === 'AI能力')?.items.length ?? 0,
    };
  }

  listWorkflows(): EditorWorkflowDef[] {
    const activeIds = new Set(this.capabilityPack.workflowIds);
    return this.listStoredWorkflows().filter((workflow) => activeIds.has(workflow.id));
  }

  /**
   * 旧草稿继续原样保存在控制面；只有 Pack 明确声明的工作流进入 V1 列表、发布和回滚。
   */
  private listStoredWorkflows(): EditorWorkflowDef[] {
    if (!this.db) return [...this.workflows.values()].map(clone);
    const rows = this.db.prepare('SELECT json FROM control_workflow_drafts WHERE tenant_id = ? AND employee_id = ? ORDER BY rowid').all(this.scope.tenantId, this.scope.employeeId) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as EditorWorkflowDef);
  }

  getWorkflow(id: string): EditorWorkflowDef | undefined {
    if (!this.db) return this.workflows.has(id) ? clone(this.workflows.get(id)!) : undefined;
    const row = this.db.prepare('SELECT json FROM control_workflow_drafts WHERE tenant_id = ? AND employee_id = ? AND workflow_id = ?').get(this.scope.tenantId, this.scope.employeeId, id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as EditorWorkflowDef : undefined;
  }

  previewBlueprintUpgrade(): EditorBlueprintUpgradePreview {
    const currentById = new Map(this.listWorkflows().map((workflow) => [workflow.id, workflow]));
    const blueprints = this.capabilityPack.defaultWorkflows().filter((workflow) => this.capabilityPack.workflowIds.includes(workflow.id));
    const workflows = blueprints.map((blueprint) => {
      const current = currentById.get(blueprint.id);
      if (!current) throw new Error(`工作流不存在: ${blueprint.id}`);
      return blueprintWorkflowDiff(current, blueprint);
    });
    const status = workflows.every((workflow) => workflow.status === 'current') ? 'current' : 'upgrade_available';
    return {
      status,
      packId: this.capabilityPack.id,
      packVersion: this.capabilityPack.initialVersion,
      reason: status === 'current'
        ? `当前 ${workflows.length} 条草稿已与 ${this.capabilityPack.initialVersion} 蓝图一致。`
        : `有 ${workflows.filter((workflow) => workflow.status === 'replace').length} 条草稿与 ${this.capabilityPack.initialVersion} 蓝图不同；导入前会在同一事务中保存完整备份。`,
      expectedRevisions: Object.fromEntries(workflows.map((workflow) => [workflow.workflowId, workflow.currentRevision])),
      workflows,
      replacesExistingDrafts: workflows.some((workflow) => workflow.status === 'replace'),
      createsBackup: true,
    };
  }

  /**
   * 显式导入 Pack 蓝图。一次事务内校验全部 revision、备份全部活动草稿、
   * 再替换草稿；不会发布版本、启动运行或触发任何连接器副作用。
   */
  importBlueprint(input: { expectedRevisions: Record<string, number>; idempotencyKey: string; actorId: string }): EditorBlueprintUpgradeResult {
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw new Error('蓝图导入需要 1–200 字符的幂等键');
    const requestFingerprint = stableJson({
      packId: this.capabilityPack.id,
      packVersion: this.capabilityPack.initialVersion,
      expectedRevisions: input.expectedRevisions,
    });
    const replay = this.readBlueprintImport(idempotencyKey);
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new EditorIdempotencyConflictError();
      return clone({ ...replay.result, status: 'replayed' });
    }

    let transaction = false;
    try {
      if (this.db) {
        this.db.exec('BEGIN IMMEDIATE');
        transaction = true;
      }
      const preview = this.previewBlueprintUpgrade();
      for (const workflow of preview.workflows) {
        const expected = input.expectedRevisions[workflow.workflowId];
        if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0) throw new EditorRevisionRequiredError();
        if (expected !== workflow.currentRevision) throw new EditorRevisionConflictError(expected, workflow.currentRevision);
      }
      if (preview.status === 'current') {
        if (transaction) this.db!.exec('COMMIT');
        return {
          status: 'already_current', importId: null, packId: preview.packId, packVersion: preview.packVersion,
          createdAt: null, preview, workflows: this.listWorkflows(),
        };
      }

      const before = this.listWorkflows();
      const currentById = new Map(before.map((workflow) => [workflow.id, workflow]));
      const now = new Date().toISOString();
      const after = this.capabilityPack.defaultWorkflows()
        .filter((workflow) => this.capabilityPack.workflowIds.includes(workflow.id))
        .map((blueprint) => {
          const current = currentById.get(blueprint.id);
          if (!current) throw new Error(`工作流不存在: ${blueprint.id}`);
          const next = ensureEditorMetadata({
            ...blueprint,
            draftRevision: current.draftRevision + 1,
            publishedRevision: current.publishedRevision,
            publishedVersion: current.publishedVersion,
            updatedAt: now,
          }).workflow;
          validateWorkflow(next);
          return next;
        });
      for (const workflow of after) this.putWorkflow(workflow);
      const result: EditorBlueprintUpgradeResult = {
        status: 'imported',
        importId: `blueprint-import:${idempotencyKey}`,
        packId: preview.packId,
        packVersion: preview.packVersion,
        createdAt: now,
        preview,
        workflows: after.map(clone),
      };
      this.writeBlueprintImport({
        idempotencyKey,
        requestFingerprint,
        actorId: input.actorId.trim() || 'unknown',
        before,
        after,
        result,
      });
      if (transaction) this.db!.exec('COMMIT');
      return clone(result);
    } catch (error) {
      if (transaction) this.db!.exec('ROLLBACK');
      throw error;
    }
  }

  previewInvoiceMatchUpgrade(id: string): InvoiceMatchUpgradePreview {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new Error(`工作流不存在: ${id}`);
    return clone(invoiceMatchUpgradePlan(workflow).preview);
  }

  /**
   * 用户确认后才写入。eligible 状态必经 saveWorkflow 的 expectedRevision 校验；
   * 已升级草稿直接返回，保证网络重试或重复点击不会再写入新版本。
   */
  upgradeInvoiceMatch(id: string, expectedRevision: number): InvoiceMatchUpgradeResult {
    const workflow = this.getWorkflow(id);
    if (!workflow) throw new Error(`工作流不存在: ${id}`);
    const plan = invoiceMatchUpgradePlan(workflow);
    if (plan.preview.status !== 'eligible') {
      return { status: plan.preview.status, preview: clone(plan.preview), workflow: clone(workflow) };
    }
    const upgraded = this.saveWorkflow(id, { ...plan.upgradedWorkflow!, expectedRevision });
    return { status: 'upgraded', preview: clone(plan.preview), workflow: upgraded };
  }

  saveWorkflow(id: string, body: Record<string, unknown>): EditorWorkflowDef {
    const expectedRevision = body['expectedRevision'];
    if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new EditorRevisionRequiredError();
    let transaction = false;
    try {
      if (this.db) {
        this.db.exec('BEGIN IMMEDIATE');
        transaction = true;
      }
      const current = this.getWorkflow(id);
      if (!current) throw new Error(`工作流不存在: ${id}`);
      if (current.draftRevision !== expectedRevision) throw new EditorRevisionConflictError(expectedRevision, current.draftRevision);
      const candidate: EditorWorkflowDef = {
        ...current,
        name: String(body['name'] ?? current.name).trim(),
        desc: String(body['desc'] ?? current.desc).trim(),
        nodes: Array.isArray(body['nodes']) ? body['nodes'] as EditorNodeDef[] : current.nodes,
        edges: Array.isArray(body['edges']) ? body['edges'] as EditorEdgeDef[] : current.edges,
        draftRevision: current.draftRevision + 1,
        updatedAt: new Date().toISOString(),
      };
      validateWorkflow(candidate);
      this.putWorkflow(candidate);
      if (transaction) this.db!.exec('COMMIT');
      return clone(candidate);
    } catch (error) {
      if (transaction) this.db!.exec('ROLLBACK');
      throw error;
    }
  }

  listVersions(): EditorVersion[] {
    if (!this.db) return this.versions.map(({ snapshot: _snapshot, ...version }) => clone(version));
    const rows = this.db.prepare('SELECT id, version, status, current, note, rule_set_version, created_at, snapshot FROM control_workflow_versions WHERE tenant_id = ? AND employee_id = ? ORDER BY seq DESC').all(this.scope.tenantId, this.scope.employeeId) as { id: string; version: string; status: 'published'; current: number; note: string; rule_set_version: string | null; created_at: string; snapshot: string }[];
    return rows.map((row) => ({ id: row.id, version: row.version, status: row.status, current: Boolean(row.current), note: row.note, createdAt: row.created_at, workflowCount: (JSON.parse(row.snapshot) as unknown[]).length, tenantId: this.scope.tenantId, employeeId: this.scope.employeeId, ...(row.rule_set_version ? { ruleSetVersion: row.rule_set_version } : {}) }));
  }

  publish(note?: string): { version: EditorVersion; workflows: EditorWorkflowDef[] } {
    const versionName = this.nextVersion();
    const now = new Date().toISOString();
    const workflows = this.listWorkflows().map((workflow) => ({ ...workflow, publishedRevision: workflow.draftRevision, publishedVersion: versionName, updatedAt: now }));
    for (const workflow of workflows) this.putWorkflow(workflow);
    this.clearCurrentVersions();
    const ruleSet = this.currentRuleSet();
    const version: EditorVersion = { id: versionName, version: versionName, status: 'published', current: true, note: note?.trim() || `发布 ${workflows.length} 个采购工作流`, createdAt: now, workflowCount: workflows.length, tenantId: this.scope.tenantId, employeeId: this.scope.employeeId, ...(ruleSet ? { ruleSetVersion: ruleSet.version } : {}) };
    this.insertVersion(version, workflows);
    return { version, workflows: workflows.map(clone) };
  }

  rollback(id: string): { version: EditorVersion; workflows: EditorWorkflowDef[]; sourceVersion: string } {
    const source = this.versionSnapshot(id);
    if (!source) throw new Error(`版本不存在: ${id}`);
    const currentById = new Map(this.listWorkflows().map((workflow) => [workflow.id, workflow]));
    const versionName = this.nextVersion();
    const now = new Date().toISOString();
    const activeIds = new Set(this.capabilityPack.workflowIds);
    const restored = source.snapshot.filter((workflow) => activeIds.has(workflow.id)).map((workflow) => {
      const nextRevision = (currentById.get(workflow.id)?.draftRevision ?? workflow.draftRevision) + 1;
      return { ...workflow, draftRevision: nextRevision, publishedRevision: nextRevision, publishedVersion: versionName, updatedAt: now };
    });
    this.replaceWorkflows(restored);
    this.clearCurrentVersions();
    const version: EditorVersion = { id: versionName, version: versionName, status: 'published', current: true, note: `回滚至 ${source.version.version}`, createdAt: now, workflowCount: restored.length, tenantId: this.scope.tenantId, employeeId: this.scope.employeeId, ...(source.version.ruleSetVersion ? { ruleSetVersion: source.version.ruleSetVersion } : {}) };
    this.insertVersion(version, restored);
    return { version, workflows: restored.map(clone), sourceVersion: source.version.version };
  }

  recordRun(run: EditorRun): EditorRun {
    const normalized: EditorRun = { ...run, tenantId: run.tenantId ?? this.scope.tenantId, employeeId: run.employeeId ?? this.scope.employeeId, updatedAt: run.updatedAt ?? run.createdAt };
    if (this.db) this.db.prepare('INSERT INTO control_workflow_runs (tenant_id, id, employee_id, workflow_id, workflow_version_id, temporal_workflow_id, status, mode, idempotency_key, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, id) DO UPDATE SET status=excluded.status,json=excluded.json,updated_at=excluded.updated_at').run(normalized.tenantId!, normalized.id, normalized.employeeId!, normalized.workflowId, normalized.workflowVersionId ?? null, normalized.temporalWorkflowId ?? null, normalized.status, normalized.mode, normalized.idempotencyKey ?? null, JSON.stringify(normalized), normalized.createdAt, normalized.updatedAt!);
    else this.runs.push(clone(normalized));
    return clone(normalized);
  }

  getRunByIdempotencyKey(idempotencyKey: string): EditorRun | undefined {
    if (!this.db) {
      const found = this.runs.find((run) => run.idempotencyKey === idempotencyKey && run.tenantId === this.scope.tenantId);
      return found ? clone(found) : undefined;
    }
    const row = this.db.prepare('SELECT json FROM control_workflow_runs WHERE tenant_id = ? AND idempotency_key = ?').get(this.scope.tenantId, idempotencyKey) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as EditorRun : undefined;
  }

  claimRun(run: EditorRun): { run: EditorRun; created: boolean } {
    const idempotencyKey = run.idempotencyKey;
    if (!idempotencyKey) throw new Error('运行缺少幂等键');
    const normalized: EditorRun = { ...run, tenantId: this.scope.tenantId, employeeId: run.employeeId ?? this.scope.employeeId, updatedAt: run.updatedAt ?? run.createdAt };
    if (!this.db) {
      const existing = this.getRunByIdempotencyKey(idempotencyKey);
      if (existing) return { run: existing, created: false };
      this.runs.push(clone(normalized));
      return { run: clone(normalized), created: true };
    }
    const result = this.db.prepare('INSERT INTO control_workflow_runs (tenant_id, id, employee_id, workflow_id, workflow_version_id, temporal_workflow_id, status, mode, idempotency_key, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, idempotency_key) DO NOTHING').run(normalized.tenantId!, normalized.id, normalized.employeeId!, normalized.workflowId, normalized.workflowVersionId ?? null, normalized.temporalWorkflowId ?? null, normalized.status, normalized.mode, idempotencyKey, JSON.stringify(normalized), normalized.createdAt, normalized.updatedAt!);
    if (Number(result.changes) === 1) return { run: clone(normalized), created: true };
    const existing = this.getRunByIdempotencyKey(idempotencyKey);
    if (!existing) throw new Error('运行幂等占位失败');
    return { run: existing, created: false };
  }

  listRuns(limit = 50): EditorRun[] {
    if (!this.db) return this.runs.slice(-limit).reverse().map(clone);
    const rows = this.db.prepare('SELECT json FROM control_workflow_runs WHERE tenant_id = ? AND employee_id = ? ORDER BY created_at DESC LIMIT ?').all(this.scope.tenantId, this.scope.employeeId, limit) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as EditorRun);
  }

  getRun(id: string): EditorRun | undefined {
    if (!this.db) return this.runs.find((run) => run.id === id) ? clone(this.runs.find((run) => run.id === id)!) : undefined;
    const row = this.db.prepare('SELECT json FROM control_workflow_runs WHERE tenant_id = ? AND employee_id = ? AND id = ?').get(this.scope.tenantId, this.scope.employeeId, id) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as EditorRun : undefined;
  }

  updateRun(id: string, patch: Partial<EditorRun>): EditorRun {
    const current = this.getRun(id);
    if (!current) throw new Error(`运行不存在: ${id}`);
    const updated: EditorRun = { ...current, ...patch, id: current.id, tenantId: current.tenantId ?? this.scope.tenantId, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    if (this.db) this.db.prepare('UPDATE control_workflow_runs SET workflow_version_id = ?, temporal_workflow_id = ?, status = ?, json = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(updated.workflowVersionId ?? null, updated.temporalWorkflowId ?? null, updated.status, JSON.stringify(updated), updated.updatedAt!, this.scope.tenantId, id);
    else {
      const index = this.runs.findIndex((run) => run.id === id);
      this.runs[index] = clone(updated);
    }
    return clone(updated);
  }

  startNodeRun(input: Omit<EditorNodeRun, 'id' | 'tenantId' | 'status' | 'sideEffectStatus'>): EditorNodeRun {
    const existing = this.listNodeRuns(input.runId).find((nodeRun) => nodeRun.nodeId === input.nodeId && nodeRun.attempt === input.attempt && nodeRun.status === 'running');
    if (existing) return existing;
    const nodeRun: EditorNodeRun = { ...input, id: `node-run:${input.runId}:${input.nodeId}:${input.attempt}`, tenantId: this.scope.tenantId, status: 'running', sideEffectStatus: 'none' };
    if (this.db) this.db.prepare('INSERT INTO control_node_runs (tenant_id, id, run_id, node_id, status, attempt, json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(tenant_id, id) DO UPDATE SET json = excluded.json, status = excluded.status').run(this.scope.tenantId, nodeRun.id, nodeRun.runId, nodeRun.nodeId, nodeRun.status, nodeRun.attempt, JSON.stringify(nodeRun), nodeRun.startedAt);
    return clone(nodeRun);
  }

  finishNodeRun(runId: string, nodeId: string, patch: Partial<EditorNodeRun>): EditorNodeRun {
    const current = this.listNodeRuns(runId).filter((item) => item.nodeId === nodeId).at(-1);
    if (!current) throw new Error(`节点运行不存在: ${runId}/${nodeId}`);
    const updated: EditorNodeRun = { ...current, ...patch, id: current.id, tenantId: current.tenantId, runId: current.runId, nodeId: current.nodeId };
    if (this.db) this.db.prepare('UPDATE control_node_runs SET status = ?, json = ?, finished_at = ? WHERE tenant_id = ? AND id = ?').run(updated.status, JSON.stringify(updated), updated.finishedAt ?? null, this.scope.tenantId, updated.id);
    this.recordBusinessActivity({
      runId,
      nodeRunId: updated.id,
      type: `node.${updated.status}`,
      title: updated.nodeLabel,
      summary: updated.error ?? updated.message ?? `${updated.nodeLabel}${updated.status === 'completed' ? '执行完成' : updated.status === 'blocked' ? '已演练，副作用被拦截' : '执行失败'}`,
      objectId: String(updated.input['businessObjectId'] ?? updated.input['objectId'] ?? '') || undefined,
      createdAt: updated.finishedAt ?? new Date().toISOString(),
    });
    return clone(updated);
  }

  listNodeRuns(runId: string): EditorNodeRun[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT json FROM control_node_runs WHERE tenant_id = ? AND run_id = ? ORDER BY started_at, rowid').all(this.scope.tenantId, runId) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as EditorNodeRun);
  }

  listBusinessActivities(runId: string): EditorBusinessActivity[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT json FROM control_business_activities WHERE tenant_id = ? AND run_id = ? ORDER BY created_at, rowid').all(this.scope.tenantId, runId) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json) as EditorBusinessActivity);
  }

  /** Records a control-plane reconciliation without fabricating or replaying a business action. */
  recordRunReconciliation(runId: string, summary: string): EditorBusinessActivity {
    return this.recordBusinessActivity({
      runId,
      nodeRunId: `reconciliation:${runId}:temporal-state`,
      type: 'run.manual_reconciliation',
      title: 'Temporal 运行对账',
      summary,
      createdAt: new Date().toISOString(),
    });
  }

  currentVersionSnapshot(workflowId: string): { version: EditorVersion; workflow: EditorWorkflowDef } | undefined {
    const current = this.listVersions().find((version) => version.current);
    if (!current) return undefined;
    const source = this.versionSnapshot(current.id);
    const workflow = source?.snapshot.find((item) => item.id === workflowId);
    return source && workflow ? { version: source.version, workflow: clone(workflow) } : undefined;
  }

  private seed(): void {
    const defaults = this.capabilityPack.defaultWorkflows();
    const storedIds = new Set(this.listStoredWorkflows().map((workflow) => workflow.id));
    for (const workflow of defaults) {
      if (!storedIds.has(workflow.id)) this.putWorkflow(workflow);
    }
    let workflows = this.listWorkflows();
    workflows = workflows.map((workflow) => {
      let changed = false;
      const nodes = workflow.nodes.map((editorNode) => {
        if (editorNode.type && editorNode.typeVersion && editorNode.icon) return editorNode;
        const nodeDescriptor = this.capabilityPack.inferNodeDescriptor(editorNode.label, editorNode.kind);
        changed = true;
        return {
          ...editorNode,
          type: editorNode.type ?? nodeDescriptor.type,
          typeVersion: editorNode.typeVersion ?? nodeDescriptor.version,
          icon: editorNode.icon ?? nodeDescriptor.icon,
          parameters: editorNode.parameters ?? Object.fromEntries(nodeDescriptor.parameters.filter((parameter) => parameter.defaultValue !== undefined).map((parameter) => [parameter.id, parameter.defaultValue!])),
          sideEffects: editorNode.sideEffects ?? nodeDescriptor.sideEffects,
        };
      });
      const metadata = ensureEditorMetadata({ ...workflow, nodes });
      const upgraded = metadata.workflow;
      if (changed || metadata.changed) this.putWorkflow(upgraded);
      return upgraded;
    });
    if (!this.currentRuleSet()) {
      this.publishRuleSet({
        deliveryDelayDays: { auto: 2, buyer: 5 },
        poPriceVariancePct: { auto: 0, buyer: 0.01 },
        threeWayVariancePct: { auto: 1, buyer: 3 },
      });
    }
    if (this.listVersions().length > 0) return;
    const now = new Date().toISOString();
    const ruleSet = this.currentRuleSet();
    this.insertVersion({ id: this.capabilityPack.initialVersion, version: this.capabilityPack.initialVersion, status: 'published', current: true, note: `${this.capabilityPack.name} Editor 初始发布版`, createdAt: now, workflowCount: workflows.length, tenantId: this.scope.tenantId, employeeId: this.scope.employeeId, ...(ruleSet ? { ruleSetVersion: ruleSet.version } : {}) }, workflows);
  }

  currentRuleSet(): EditorRuleSet | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare('SELECT json FROM control_rule_sets WHERE tenant_id = ? AND employee_id = ? AND current = 1 ORDER BY rowid DESC LIMIT 1').get(this.scope.tenantId, this.scope.employeeId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as EditorRuleSet : undefined;
  }

  publishRuleSet(thresholds: Record<string, { auto: number; buyer: number }>): EditorRuleSet {
    for (const [kind, value] of Object.entries(thresholds)) {
      if (!Number.isFinite(value.auto) || !Number.isFinite(value.buyer) || value.auto < 0 || value.buyer <= value.auto) throw new Error(`规则阈值无效: ${kind}`);
    }
    const current = this.currentRuleSet();
    const nextNumber = current ? Number(current.version.split('.').at(-1) ?? 0) + 1 : 1;
    const version = `rules.v1.${nextNumber}`;
    const createdAt = new Date().toISOString();
    const ruleSet: EditorRuleSet = { id: version, tenantId: this.scope.tenantId, employeeId: this.scope.employeeId, version, status: 'published', current: true, thresholds: clone(thresholds), createdAt };
    if (this.db) {
      this.db.prepare('UPDATE control_rule_sets SET current = 0 WHERE tenant_id = ? AND employee_id = ? AND current = 1').run(this.scope.tenantId, this.scope.employeeId);
      this.db.prepare('INSERT INTO control_rule_sets (tenant_id, employee_id, id, version, status, current, json, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(this.scope.tenantId, this.scope.employeeId, ruleSet.id, ruleSet.version, ruleSet.status, JSON.stringify(ruleSet), createdAt);
    }
    return clone(ruleSet);
  }

  private migrateLegacy(): void {
    if (!this.db) return;
    // 旧 Editor 表属于历史上的唯一采购员工，绝不能复制给其他员工。
    if (this.scope.employeeId !== 'ai:procurement') return;
    const existing = this.db.prepare('SELECT COUNT(*) AS count FROM control_workflow_drafts WHERE tenant_id = ? AND employee_id = ?').get(this.scope.tenantId, this.scope.employeeId) as { count: number };
    if (existing.count > 0) return;
    const legacyWorkflows = this.db.prepare('SELECT id, json, updated_at FROM editor_workflows ORDER BY rowid').all() as { id: string; json: string; updated_at: string }[];
    for (const row of legacyWorkflows) {
      this.db.prepare('INSERT OR IGNORE INTO control_workflow_drafts (tenant_id, employee_id, workflow_id, json, updated_at) VALUES (?, ?, ?, ?, ?)').run(this.scope.tenantId, this.scope.employeeId, row.id, row.json, row.updated_at);
    }
    const legacyVersions = this.db.prepare('SELECT id, version, status, current, note, snapshot, created_at FROM editor_versions ORDER BY seq').all() as { id: string; version: string; status: string; current: number; note: string; snapshot: string; created_at: string }[];
    for (const row of legacyVersions) {
      this.db.prepare('INSERT OR IGNORE INTO control_workflow_versions (tenant_id, employee_id, id, version, status, current, note, rule_set_version, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)').run(this.scope.tenantId, this.scope.employeeId, row.id, row.version, row.status, row.current, row.note, row.snapshot, row.created_at);
    }
    const legacyRuns = this.db.prepare('SELECT id, workflow_id, mode, status, json, created_at FROM editor_runs ORDER BY created_at').all() as { id: string; workflow_id: string; mode: string; status: string; json: string; created_at: string }[];
    for (const row of legacyRuns) {
      const parsed = JSON.parse(row.json) as EditorRun;
      const normalized: EditorRun = { ...parsed, tenantId: this.scope.tenantId, employeeId: this.scope.employeeId, runtime: parsed.runtime ?? 'legacy', updatedAt: parsed.updatedAt ?? parsed.createdAt };
      this.db.prepare('INSERT OR IGNORE INTO control_workflow_runs (tenant_id, id, employee_id, workflow_id, workflow_version_id, temporal_workflow_id, status, mode, idempotency_key, json, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?)').run(this.scope.tenantId, row.id, this.scope.employeeId, row.workflow_id, row.status, row.mode, JSON.stringify(normalized), row.created_at, normalized.updatedAt!);
    }
  }

  private repairCrossEmployeeLegacyLeak(): void {
    if (!this.db || this.scope.employeeId === 'ai:procurement') return;
    const procurementWorkflowIds = new Set(['procurement-orchestrator', 'rfq-process', 'po-operations', 'supplier-followup', 'delivery-receipt', 'invoice-match']);
    const rows = this.db.prepare('SELECT workflow_id,json FROM control_workflow_drafts WHERE tenant_id=? AND employee_id=?').all(this.scope.tenantId, this.scope.employeeId) as Array<{ workflow_id: string; json: string }>;
    if (rows.length === 0 || rows.some((row) => !procurementWorkflowIds.has(row.workflow_id))) return;
    const now = new Date().toISOString();
    for (const row of rows) {
      this.db.prepare('INSERT OR IGNORE INTO control_workflow_quarantine (tenant_id,employee_id,kind,id,json,quarantined_at) VALUES (?,?,?,?,?,?)').run(this.scope.tenantId, this.scope.employeeId, 'legacy-workflow-leak', row.workflow_id, row.json, now);
    }
    const versions = this.db.prepare('SELECT id,snapshot FROM control_workflow_versions WHERE tenant_id=? AND employee_id=?').all(this.scope.tenantId, this.scope.employeeId) as Array<{ id: string; snapshot: string }>;
    for (const version of versions) {
      this.db.prepare('INSERT OR IGNORE INTO control_workflow_quarantine (tenant_id,employee_id,kind,id,json,quarantined_at) VALUES (?,?,?,?,?,?)').run(this.scope.tenantId, this.scope.employeeId, 'legacy-version-leak', version.id, version.snapshot, now);
    }
    this.db.prepare('DELETE FROM control_workflow_drafts WHERE tenant_id=? AND employee_id=?').run(this.scope.tenantId, this.scope.employeeId);
    this.db.prepare('DELETE FROM control_workflow_versions WHERE tenant_id=? AND employee_id=?').run(this.scope.tenantId, this.scope.employeeId);
  }

  private putWorkflow(workflow: EditorWorkflowDef): void {
    if (this.db) this.db.prepare('INSERT INTO control_workflow_drafts (tenant_id, employee_id, workflow_id, json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(tenant_id, employee_id, workflow_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(this.scope.tenantId, this.scope.employeeId, workflow.id, JSON.stringify(workflow), workflow.updatedAt);
    else this.workflows.set(workflow.id, clone(workflow));
  }

  private readBlueprintImport(idempotencyKey: string): { requestFingerprint: string; result: EditorBlueprintUpgradeResult } | undefined {
    if (!this.db) return this.blueprintImports.get(idempotencyKey);
    const row = this.db.prepare('SELECT request_fingerprint, result_json FROM control_workflow_blueprint_imports WHERE tenant_id = ? AND employee_id = ? AND idempotency_key = ?')
      .get(this.scope.tenantId, this.scope.employeeId, idempotencyKey) as { request_fingerprint: string; result_json: string } | undefined;
    return row ? { requestFingerprint: row.request_fingerprint, result: JSON.parse(row.result_json) as EditorBlueprintUpgradeResult } : undefined;
  }

  private writeBlueprintImport(input: {
    idempotencyKey: string;
    requestFingerprint: string;
    actorId: string;
    before: EditorWorkflowDef[];
    after: EditorWorkflowDef[];
    result: EditorBlueprintUpgradeResult;
  }): void {
    if (!this.db) {
      this.blueprintImports.set(input.idempotencyKey, { requestFingerprint: input.requestFingerprint, result: clone(input.result) });
      return;
    }
    this.db.prepare(`INSERT INTO control_workflow_blueprint_imports
      (tenant_id, employee_id, idempotency_key, request_fingerprint, pack_id, pack_version, actor_id, before_snapshot, after_snapshot, result_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        this.scope.tenantId,
        this.scope.employeeId,
        input.idempotencyKey,
        input.requestFingerprint,
        this.capabilityPack.id,
        this.capabilityPack.initialVersion,
        input.actorId,
        JSON.stringify(input.before),
        JSON.stringify(input.after),
        JSON.stringify(input.result),
        input.result.createdAt,
      );
  }

  private recordBusinessActivity(input: Omit<EditorBusinessActivity, 'id' | 'tenantId'>): EditorBusinessActivity {
    const activity: EditorBusinessActivity = { ...input, id: `business-activity:${input.nodeRunId}`, tenantId: this.scope.tenantId };
    this.db?.prepare('INSERT INTO control_business_activities (tenant_id, id, run_id, node_run_id, type, title, summary, object_id, json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, id) DO UPDATE SET type = excluded.type, title = excluded.title, summary = excluded.summary, object_id = excluded.object_id, json = excluded.json, created_at = excluded.created_at').run(this.scope.tenantId, activity.id, activity.runId, activity.nodeRunId, activity.type, activity.title, activity.summary, activity.objectId ?? null, JSON.stringify(activity), activity.createdAt);
    return clone(activity);
  }

  private replaceWorkflows(workflows: EditorWorkflowDef[]): void {
    if (this.db) {
      const remove = this.db.prepare('DELETE FROM control_workflow_drafts WHERE tenant_id = ? AND employee_id = ? AND workflow_id = ?');
      for (const workflowId of this.capabilityPack.workflowIds) remove.run(this.scope.tenantId, this.scope.employeeId, workflowId);
      for (const workflow of workflows) this.putWorkflow(workflow);
    } else {
      for (const workflowId of this.capabilityPack.workflowIds) this.workflows.delete(workflowId);
      for (const workflow of workflows) this.workflows.set(workflow.id, clone(workflow));
    }
  }

  private nextVersion(): string {
    const versions = this.listVersions().map((item) => item.version).filter((version) => /^v\d+\.\d+\.\d+$/.test(version));
    const [major = 0, minor = 1, initialPatch = 0] = this.capabilityPack.initialVersion.slice(1).split('.').map(Number);
    const prefix = `v${major}.${minor}.`;
    const patches = versions
      .filter((version) => version.startsWith(prefix))
      .map((version) => Number(version.split('.').at(-1)))
      .filter(Number.isFinite);
    patches.push(initialPatch);
    return `v${major}.${minor}.${Math.max(-1, ...patches) + 1}`;
  }

  private clearCurrentVersions(): void {
    if (this.db) this.db.prepare('UPDATE control_workflow_versions SET current = 0 WHERE tenant_id = ? AND employee_id = ? AND current = 1').run(this.scope.tenantId, this.scope.employeeId);
    else for (const version of this.versions) version.current = false;
  }

  private insertVersion(version: EditorVersion, snapshot: EditorWorkflowDef[]): void {
    if (this.db) this.db.prepare('INSERT INTO control_workflow_versions (tenant_id, employee_id, id, version, status, current, note, rule_set_version, snapshot, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(this.scope.tenantId, this.scope.employeeId, version.id, version.version, version.status, version.current ? 1 : 0, version.note, version.ruleSetVersion ?? null, JSON.stringify(snapshot), version.createdAt);
    else this.versions.push({ ...clone(version), snapshot: snapshot.map(clone) });
  }

  private versionSnapshot(id: string): { version: EditorVersion; snapshot: EditorWorkflowDef[] } | undefined {
    if (!this.db) {
      const found = this.versions.find((version) => version.id === id);
      return found ? { version: clone(found), snapshot: found.snapshot.map(clone) } : undefined;
    }
    const row = this.db.prepare('SELECT id, version, status, current, note, rule_set_version, snapshot, created_at FROM control_workflow_versions WHERE tenant_id = ? AND employee_id = ? AND id = ?').get(this.scope.tenantId, this.scope.employeeId, id) as { id: string; version: string; status: 'published'; current: number; note: string; rule_set_version: string | null; snapshot: string; created_at: string } | undefined;
    if (!row) return undefined;
    const snapshot = JSON.parse(row.snapshot) as EditorWorkflowDef[];
    return { version: { id: row.id, version: row.version, status: row.status, current: Boolean(row.current), note: row.note, createdAt: row.created_at, workflowCount: snapshot.length, tenantId: this.scope.tenantId, employeeId: this.scope.employeeId, ...(row.rule_set_version ? { ruleSetVersion: row.rule_set_version } : {}) }, snapshot };
  }
}

function validateWorkflow(workflow: EditorWorkflowDef): void {
  if (!workflow.name || workflow.name.length > 80) throw new Error('工作流名称长度必须在 1–80 之间');
  if (workflow.nodes.length === 0 || workflow.nodes.length > 200) throw new Error('工作流节点数必须在 1–200 之间');
  const nodeIds = new Set<string>();
  for (const item of workflow.nodes) {
    if (!item.id || !item.label || !['trigger', 'router', 'ai', 'logic', 'tool', 'approval', 'action'].includes(item.kind)) throw new Error('节点缺少有效的 id、名称或类型');
    if (nodeIds.has(item.id)) throw new Error(`节点 id 重复: ${item.id}`);
    if (item.position && (!Number.isFinite(item.position.x) || !Number.isFinite(item.position.y))) throw new Error(`节点坐标无效: ${item.id}`);
    nodeIds.add(item.id);
  }
  const successors = new Map<string, string[]>();
  const edgeIds = new Set<string>();
  for (const item of workflow.edges) {
    if (!nodeIds.has(item.from) || !nodeIds.has(item.to)) throw new Error(`连线引用了不存在的节点: ${item.from} -> ${item.to}`);
    if (item.from === item.to) throw new Error('节点不能连接自己');
    if (item.id && edgeIds.has(item.id)) throw new Error(`连线 id 重复: ${item.id}`);
    if (item.id) edgeIds.add(item.id);
    successors.set(item.from, [...(successors.get(item.from) ?? []), item.to]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('工作流不能包含循环连线');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of successors.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodeIds) visit(id);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
