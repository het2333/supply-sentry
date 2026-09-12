import type { NodeExecutor, NodeTypeDescriptor } from '@readywork/graph-runtime';
import { NodeFactory } from '@readywork/graph-runtime';

export type ProcurementNodeKind = 'trigger' | 'router' | 'ai' | 'logic' | 'tool' | 'approval' | 'action';

export interface ProcurementNodeAsset {
  assetId: string;
  group: '触发器' | 'AI能力' | '业务逻辑' | '工具';
  kind: ProcurementNodeKind;
  descriptor: NodeTypeDescriptor;
}

const input = (id: string, label: string, dataType: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'file' | 'event' | 'any' = 'any', required = false) => ({ id, label, dataType, required });
const output = (id: string, label: string, dataType: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'file' | 'event' | 'any' = 'any') => ({ id, label, dataType });

function descriptor(inputDescriptor: Omit<NodeTypeDescriptor, 'version' | 'runtime' | 'executor' | 'parameters' | 'credentials'> & Partial<Pick<NodeTypeDescriptor, 'runtime' | 'executor' | 'parameters' | 'credentials'>>): NodeTypeDescriptor {
  return {
    version: 1,
    runtime: 'builtin',
    executor: `builtin:${inputDescriptor.type}`,
    parameters: [],
    credentials: [],
    ...inputDescriptor,
  };
}

function asset(assetId: string, group: ProcurementNodeAsset['group'], kind: ProcurementNodeKind, nodeDescriptor: NodeTypeDescriptor): ProcurementNodeAsset {
  return { assetId, group, kind, descriptor: nodeDescriptor };
}

export const PROCUREMENT_NODE_ASSETS: ProcurementNodeAsset[] = [
  asset('t:erp', '触发器', 'trigger', descriptor({ type: 'trigger.erp_event', name: 'ERP事件', description: '订单、发票、到货等采购域事件进入工作流。', icon: 'database-zap', category: 'trigger', inputs: [], outputs: [output('event', '事件事实', 'event')] })),
  asset('t:mail', '触发器', 'trigger', descriptor({ type: 'trigger.email_received', name: '收到邮件', description: '供应商报价、确认或交期回复进入工作流。', icon: 'mail-open', category: 'trigger', inputs: [], outputs: [output('message', '邮件', 'object')] })),
  asset('t:cron', '触发器', 'trigger', descriptor({ type: 'trigger.schedule', name: '定时任务', description: '周期检查延期、未确认订单或待收货状态。', icon: 'clock-3', category: 'trigger', inputs: [], outputs: [output('scheduled_at', '触发时间', 'string')], parameters: [{ id: 'cron', label: 'Cron 表达式', control: 'text', required: true, defaultValue: '0 9 * * 1-5', description: '按租户时区执行。' }] })),
  asset('t:manual', '触发器', 'trigger', descriptor({ type: 'trigger.manual', name: '人工触发', description: '采购人员从业务工作台手动发起。', icon: 'mouse-pointer-click', category: 'trigger', inputs: [], outputs: [output('input', '人工输入', 'object')] })),

  asset('ai:quote-collect', 'AI能力', 'ai', descriptor({ type: 'ai.quote_collect', name: '报价收集', description: '汇总各家供应商报价与附件。', icon: 'inbox', category: 'ai', inputs: [input('messages', '报价邮件', 'array', true)], outputs: [output('quotes', '报价汇总', 'array')] })),
  asset('ai:quote-reco', 'AI能力', 'ai', descriptor({ type: 'ai.quote_recommend', name: '比价推荐', description: '按价格、交期与履约表现推荐供应商。', icon: 'chart-no-axes-combined', category: 'ai', inputs: [input('quotes', '结构化报价', 'array', true)], outputs: [output('recommendation', '推荐结果', 'object')], parameters: [{ id: 'priceWeight', label: '价格权重', control: 'number', defaultValue: 0.6 }, { id: 'leadTimeWeight', label: '交期权重', control: 'number', defaultValue: 0.2 }, { id: 'performanceWeight', label: '履约权重', control: 'number', defaultValue: 0.2 }] })),
  asset('ai:po-check', 'AI能力', 'ai', descriptor({ type: 'ai.po_check', name: '订单核对', description: '核对采购订单与当前业务事实。', icon: 'list-checks', category: 'ai', inputs: [input('po', '采购订单', 'object', true)], outputs: [output('result', '核对结果', 'object')] })),
  asset('ai:reply-parse', 'AI能力', 'ai', descriptor({ type: 'ai.supplier_reply_parse', name: '回复解析', description: '优先用零模型 token 的确定性规则提取数量、单价和交期，同时保留冲突与缺失字段供人工核对。', icon: 'message-square-text', category: 'ai', inputs: [input('message', '供应商回复', 'object', true), input('poLines', 'PO 行', 'array'), input('earlierCommunications', '较早回复', 'array'), input('referenceYear', '参考年份', 'number')], outputs: [output('intent', '回复意图', 'string'), output('facts', '结构化核对建议', 'object')] })),
  asset('ai:eta-extract', 'AI能力', 'ai', descriptor({ type: 'ai.delivery_date_extract', name: '交期提取', description: '从供应商回复提取最新承诺交期。', icon: 'calendar-search', category: 'ai', inputs: [input('text', '回复文本', 'string', true)], outputs: [output('promise_date', '承诺交期', 'string'), output('confidence', '置信度', 'number')] })),
  asset('ai:followup', 'AI能力', 'ai', descriptor({ type: 'ai.followup_compose', name: '催交沟通', description: '生成符合采购语境的催交内容。', icon: 'messages-square', category: 'ai', inputs: [input('po', '订单事实', 'object', true)], outputs: [output('subject', '主题', 'string'), output('body', '正文', 'string')] })),
  asset('ai:inv-parse', 'AI能力', 'ai', descriptor({ type: 'ai.invoice_recognize', name: '发票识别', description: '提取发票要素与关联采购单。', icon: 'scan-text', category: 'ai', inputs: [input('invoice', '发票文件', 'file', true)], outputs: [output('fields', '发票要素', 'object')] })),
  asset('ai:threeway', 'AI能力', 'ai', descriptor({ type: 'ai.three_way_match', name: '三单匹配（旧版）', description: '旧版总额三单核对；新流程请使用确定性的「行级三单匹配」业务节点。', icon: 'git-compare-arrows', category: 'ai', inputs: [input('po', '采购单', 'object', true), input('receipt', '收货单', 'object', true), input('invoice', '发票', 'object', true)], outputs: [output('result', '匹配结果', 'object')] })),
  asset('ai:intent', 'AI能力', 'ai', descriptor({ type: 'ai.procurement_event_classify', name: '事件识别', description: '识别采购事件及其业务意图。', icon: 'sparkles', category: 'ai', inputs: [input('event', '采购事件', 'event', true)], outputs: [output('intent', '事件意图', 'string'), output('facts', '事实', 'object')] })),

  asset('l:cond', '业务逻辑', 'logic', descriptor({ type: 'logic.condition', name: '条件', description: '根据表达式选择一个或多个分支。', icon: 'split', category: 'logic', inputs: [input('value', '判断输入')], outputs: [output('true', '满足'), output('false', '不满足')], parameters: [{ id: 'expression', label: '条件表达式', control: 'expression', required: true, defaultValue: '{{ input.value }}' }] })),
  asset('l:router', '业务逻辑', 'router', descriptor({ type: 'business.procurement_path_router', name: '采购路径判断', description: '按 PO、合同价、发票和收货状态动态选择采购路径。', icon: 'route', category: 'business', inputs: [input('event', '采购事实', 'object', true)], outputs: [output('rfq', '询价'), output('po_execution', 'PO执行'), output('invoice_match', '发票处理'), output('wait_receipt', '等待收货'), output('exception', '异常')] })),
  asset('l:wait', '业务逻辑', 'logic', descriptor({ type: 'logic.wait_event', name: '等待', description: '持久化挂起，收到外部事件或超时后恢复。', icon: 'pause', category: 'logic', inputs: [input('state', '当前状态', 'object')], outputs: [output('event', '恢复事件', 'event'), output('timeout', '超时')], parameters: [{ id: 'eventType', label: '等待事件', control: 'text', required: true }, { id: 'timeoutMs', label: '超时（毫秒）', control: 'number', defaultValue: 259200000 }] })),
  asset('l:approval', '业务逻辑', 'approval', descriptor({ type: 'human.approval', name: '审批', description: '创建人工输入请求，挂起并在处理后从断点恢复。', icon: 'shield-check', category: 'human', inputs: [input('request', '审批内容', 'object', true)], outputs: [output('approved', '已批准', 'object'), output('rejected', '已驳回', 'object')], parameters: [{ id: 'assigneeRole', label: '审批角色', control: 'select', required: true, defaultValue: 'manager', options: [{ label: '采购员', value: 'buyer' }, { label: '采购经理', value: 'manager' }, { label: '财务', value: 'finance' }] }, { id: 'timeoutMs', label: '审批超时（毫秒）', control: 'number', defaultValue: 86400000 }] })),
  asset('l:parallel', '业务逻辑', 'logic', descriptor({ type: 'logic.parallel', name: '并行', description: '同时调度多个互不依赖的执行分支。', icon: 'git-fork', category: 'logic', inputs: [input('input', '共享输入')], outputs: [output('branches', '并行分支', 'array')] })),
  asset('l:business-action', '业务逻辑', 'action', descriptor({ type: 'business.action', name: '业务动作', description: '记录通知、关单或工作流级业务动作。', icon: 'circle-play', category: 'business', inputs: [input('input', '业务输入', 'object')], outputs: [output('result', '业务结果', 'object')] })),
  asset('b:line-threeway', '业务逻辑', 'action', descriptor({
    type: 'business.procurement_line_match', name: '行级三单匹配', description: '基于 PO 行、收货行、发票行与历史分配进行确定性三单匹配；不调用 AI 或外部系统。', icon: 'git-compare-arrows', category: 'business',
    inputs: [input('poLine', '采购订单行', 'object', true), input('receiptLines', '收货行', 'array', true), input('invoiceLine', '供应商发票行', 'object', true), input('policy', '匹配容差策略', 'object', true), input('previouslyAllocatedQtyByReceiptLineId', '历史已分配数量', 'object')],
    outputs: [output('result', '行匹配结果', 'object'), output('variances', '差异明细', 'object'), output('allocations', '收货分配', 'array'), output('disposition', '匹配处置', 'string')],
  })),

  asset('tool:mail', '工具', 'tool', descriptor({
    type: 'connector.email.send_supplier_email', name: '发送供应商邮件', description: '通过已配置企业邮箱向供应商发送邮件与附件。', icon: 'send', category: 'connector', runtime: 'connector', executor: 'connector:email.send',
    inputs: [input('supplier_id', '供应商 ID', 'string', true), input('subject', '邮件主题', 'string', true), input('body', '邮件正文', 'string', true), input('attachments', '附件', 'array')],
    outputs: [output('message_id', '消息 ID', 'string'), output('sent_at', '发送时间', 'string')],
    parameters: [{ id: 'fromName', label: '发件人名称', control: 'text', defaultValue: '采购执行员工' }, { id: 'replyTo', label: '回复地址', control: 'text' }],
    credentials: [{ type: 'emailCredential', required: true, scopes: ['email.send'], description: 'SMTP、Microsoft 365 或企业邮箱连接。' }],
    sideEffects: ['发送外部邮件'], timeoutMs: 30000, retry: { maximumAttempts: 3, initialIntervalMs: 1000, maximumIntervalMs: 10000 },
  })),
  asset('tool:erp', '工具', 'tool', descriptor({ type: 'connector.erp.action', name: 'ERP', description: '读取或回写采购订单、询价与应付状态。', icon: 'database', category: 'connector', runtime: 'connector', executor: 'connector:erp.dynamic', inputs: [input('object', '业务对象', 'object', true)], outputs: [output('result', 'ERP 结果', 'object')], parameters: [{ id: 'action', label: 'ERP 动作', control: 'select', required: true, options: [{ label: '读取采购单', value: 'po.get' }, { label: '创建 Odoo 采购单草稿', value: 'po.create_draft' }, { label: '更新采购单', value: 'po.update' }, { label: '创建询价', value: 'rfq.create' }, { label: '应付审核回写', value: 'invoice.update' }] }], credentials: [{ type: 'erpCredential', required: true }], sideEffects: ['写 ERP'] })),
  asset('tool:wms', '工具', 'tool', descriptor({ type: 'connector.wms.action', name: 'WMS', description: '读取收货事件或登记入库。', icon: 'warehouse', category: 'connector', runtime: 'connector', executor: 'connector:wms.dynamic', inputs: [input('receipt', '收货数据', 'object', true)], outputs: [output('result', 'WMS 结果', 'object')], credentials: [{ type: 'wmsCredential', required: true }], sideEffects: ['写 WMS'] })),
  asset('tool:file', '工具', 'tool', descriptor({ type: 'connector.file.action', name: '文件', description: '读取附件或登记采购台账。', icon: 'file-spreadsheet', category: 'connector', runtime: 'connector', executor: 'connector:file.dynamic', inputs: [input('data', '数据', 'object', true)], outputs: [output('result', '文件结果', 'object')], parameters: [{ id: 'action', label: '文件动作', control: 'select', required: true, defaultValue: 'appendRow', options: [{ label: '追加台账', value: 'appendRow' }, { label: '读取表格', value: 'read' }] }], sideEffects: ['写业务文件'] })),
];

export const PROCUREMENT_NODE_DESCRIPTORS = PROCUREMENT_NODE_ASSETS.map((item) => item.descriptor);

export function procurementNodeAsset(assetId: string): ProcurementNodeAsset | undefined {
  return PROCUREMENT_NODE_ASSETS.find((item) => item.assetId === assetId);
}

export function inferProcurementNodeDescriptor(label: string, kind: ProcurementNodeKind): NodeTypeDescriptor {
  const exact = PROCUREMENT_NODE_ASSETS.find((item) => item.kind === kind && (item.descriptor.name === label || label.includes(item.descriptor.name) || item.descriptor.name.includes(label)));
  if (exact) return exact.descriptor;
  const fallback = PROCUREMENT_NODE_ASSETS.find((item) => item.kind === kind);
  if (fallback) return fallback.descriptor;
  throw new Error(`没有可用的采购节点描述: ${kind}/${label}`);
}

export function createProcurementNodeFactory(resolveExecutor: (descriptor: NodeTypeDescriptor) => NodeExecutor): NodeFactory {
  const factory = new NodeFactory();
  for (const item of PROCUREMENT_NODE_ASSETS) factory.register(item.descriptor, resolveExecutor(item.descriptor));
  return factory;
}
