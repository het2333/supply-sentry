import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import type { ToolRegistry } from '@readywork/tools';
import { ImapClient, OdooErpClient, sendMail } from '@readywork/connectors';
import type { OdooPurchaseOrderDraftInput, SendMailInput } from '@readywork/connectors';
import {
  ConnectorRegistry as RuntimeConnectorRegistry,
  CredentialVault,
  LocalProcessConnectorAdapter,
  type ConnectorAdapter,
  type ConnectorDescriptor,
  type ConnectorExecutionContext,
  type ConnectorExecutionResult,
  type EncryptedCredential,
} from '@readywork/connector-runtime';
import { redactSensitive, redactSensitiveValue } from './http-errors.js';
import { WhatsAppCloudApiClient } from './whatsapp-cloud.js';

const p = (id: string, label: string, dataType: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'file' | 'event' | 'any' = 'any', required = false) => ({ id, label, dataType, required });

function connectorErrorMessage(error: unknown): string {
  const message = redactSensitive(error, 500);
  if (message.includes('user in black list')) return 'SMTP 已连接；网易 IMAP 当前拒绝第三方客户端登录，请在邮箱安全设置中解除 IMAP 客户端限制';
  if (message.includes('Unsafe Login')) return '网易邮箱拒绝了不安全登录，请确认 IMAP/SMTP 服务和客户端授权已开启';
  return message;
}

function emailAttachments(value: unknown): NonNullable<SendMailInput['attachments']> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('邮件附件必须是数组');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`邮件附件 ${index + 1} 格式无效`);
    const attachment = item as Record<string, unknown>;
    const filename = String(attachment['filename'] ?? '').trim();
    const contentType = String(attachment['contentType'] ?? '').trim();
    const content = attachment['content'];
    if (!filename || !contentType || !(content instanceof Uint8Array)) throw new Error(`邮件附件 ${index + 1} 缺少名称、类型或二进制内容`);
    return { filename, contentType, content };
  });
}

function odooClientFromCredentials(credentials: Record<string, unknown>): OdooErpClient {
  const baseUrl = String(credentials['baseUrl'] ?? '').replace(/\/$/, '');
  const database = String(credentials['database'] ?? '');
  const apiKey = String(credentials['apiKey'] ?? '');
  if (!baseUrl || !database || !apiKey) throw new Error('Odoo 凭据缺少服务地址、数据库或 API Key');
  return new OdooErpClient({ baseUrl, database, apiKey, timeoutMs: 10_000 });
}

function odooPurchaseOrderDraftInput(input: Record<string, unknown>): OdooPurchaseOrderDraftInput {
  const correlationKey = requiredConnectorText(input['correlationKey'], 'correlationKey');
  const partnerId = input['partnerId'];
  if (!(typeof partnerId === 'number' && Number.isSafeInteger(partnerId) && partnerId > 0) && !(typeof partnerId === 'string' && /^(?:odoo-)?[1-9]\d*$/.test(partnerId))) {
    throw new Error('Odoo 供应商 ID 必须是正整数');
  }
  const currencyCode = requiredConnectorText(input['currencyCode'], 'currencyCode').toUpperCase();
  const rawLines = input['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw new Error('采购行必须是非空数组');
  return {
    correlationKey,
    partnerId,
    currencyCode,
    lines: rawLines.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`采购行 ${index + 1} 格式无效`);
      const line = raw as Record<string, unknown>;
      const itemCode = requiredConnectorText(line['itemCode'], `采购行 ${index + 1} 物料编码`);
      const quantity = line['quantity'];
      const priceUnit = line['priceUnit'];
      if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) throw new Error(`采购行 ${index + 1} 数量必须大于 0`);
      if (typeof priceUnit !== 'number' || !Number.isFinite(priceUnit) || priceUnit < 0) throw new Error(`采购行 ${index + 1} 单价必须是非负数`);
      const description = line['description'];
      const datePlanned = line['datePlanned'];
      if (description !== undefined && typeof description !== 'string') throw new Error(`采购行 ${index + 1} 描述无效`);
      if (datePlanned !== undefined && typeof datePlanned !== 'string') throw new Error(`采购行 ${index + 1} 计划日期无效`);
      return { itemCode, quantity, priceUnit, ...(description?.trim() ? { description: description.trim() } : {}), ...(datePlanned?.trim() ? { datePlanned: datePlanned.trim() } : {}) };
    }),
  };
}

function requiredConnectorText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 必填`);
  return value.trim();
}

async function deepSeekAccountHealth(credentials: Record<string, unknown>): Promise<{ currencies: string[] }> {
  const apiKey = String(credentials['apiKey'] ?? '').trim();
  if (!apiKey) throw new Error('DeepSeek API 密钥必填');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } catch {
    throw new Error(controller.signal.aborted ? 'DeepSeek API 连接超时' : 'DeepSeek API 连接失败');
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 401) throw new Error('DeepSeek API 密钥无效');
  if (response.status === 402) throw new Error('DeepSeek 账户余额不足');
  if (!response.ok) throw new Error(`DeepSeek API 连接失败（HTTP ${response.status}）`);
  const payload = await response.json() as { is_available?: boolean; balance_infos?: Array<{ currency?: unknown }> };
  if (payload.is_available !== true) throw new Error('DeepSeek 账户余额不足');
  return {
    currencies: Array.isArray(payload.balance_infos)
      ? payload.balance_infos.map((item) => String(item.currency ?? '').trim()).filter(Boolean)
      : [],
  };
}

export const CONNECTOR_CATALOG: ConnectorDescriptor[] = [
  {
    id: 'email', version: 1, name: '企业邮箱', description: '供应商邮件收发；支持 SMTP 与 IMAP，当前可直接使用网易 163 企业邮箱。', icon: 'mail', vendor: 'Readywork', category: '通信', runtime: 'builtin', distribution: 'builtin', tags: ['SMTP', 'IMAP', '采购沟通'],
    credentials: [{ type: 'emailCredential', required: true, scopes: ['email.send', 'email.read'] }],
    credentialSchemas: [{
      type: 'emailCredential', name: '邮箱账号', testable: true, fields: [
        { id: 'username', label: '邮箱地址', type: 'text', required: true, placeholder: 'name@company.com' },
        { id: 'authorizationCode', label: '授权码', type: 'password', required: true, secret: true },
        { id: 'smtpHost', label: 'SMTP 主机', type: 'text', required: true, defaultValue: 'smtp.163.com' },
        { id: 'smtpPort', label: 'SMTP 端口', type: 'number', required: true, defaultValue: 465 },
        { id: 'imapHost', label: 'IMAP 主机', type: 'text', required: true, defaultValue: 'imap.163.com' },
        { id: 'imapPort', label: 'IMAP 端口', type: 'number', required: true, defaultValue: 993 },
        { id: 'secure', label: '使用 TLS', type: 'boolean', defaultValue: true },
      ],
    }],
    actions: [
      { id: 'send', name: '发送邮件', description: '发送供应商邮件与附件。', inputs: [p('to', '收件地址', 'string', true), p('fromName', '供应商可见发件人', 'string'), p('subject', '主题', 'string', true), p('body', '正文', 'string', true), p('attachments', '附件', 'array')], outputs: [p('message_id', '消息 ID', 'string'), p('sent_at', '发送时间', 'string')], parameters: [], sideEffects: ['发送外部邮件'], idempotent: true, risk: 'medium' },
      { id: 'inbox.list', name: '读取收件箱', description: '读取供应商来信。', inputs: [], outputs: [p('messages', '邮件', 'array')], parameters: [], sideEffects: [], idempotent: true, risk: 'read' },
    ],
  },
  {
    id: 'whatsapp', version: 1, name: 'WhatsApp Business', description: '通过 Meta WhatsApp Cloud API 发送已批准模板消息，并持久化 accepted / sent / delivered / read / failed 回执。', icon: 'message-circle', vendor: 'Meta', category: '通信', runtime: 'builtin', distribution: 'builtin', tags: ['WhatsApp', 'Meta Cloud API', '供应商跟进'],
    credentials: [{ type: 'whatsappBusinessCredential', required: true, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'] }],
    credentialSchemas: [{
      type: 'whatsappBusinessCredential', name: 'Meta WhatsApp Business', testable: true, fields: [
        { id: 'phoneNumberId', label: 'Phone Number ID', type: 'text', required: true },
        { id: 'businessAccountId', label: 'WhatsApp Business Account ID', type: 'text', required: true },
        { id: 'accessToken', label: 'System User Access Token', type: 'password', required: true, secret: true },
        { id: 'appSecret', label: 'Meta App Secret', type: 'password', required: true, secret: true },
        { id: 'verifyToken', label: 'Webhook Verify Token', type: 'password', required: true, secret: true },
        { id: 'apiVersion', label: 'Graph API 版本', type: 'text', required: true, defaultValue: 'v23.0' },
        { id: 'templateName', label: '已批准跟进模板名', type: 'text', required: true, placeholder: 'purchase_order_followup' },
        { id: 'languageCode', label: '模板语言', type: 'text', required: true, defaultValue: 'zh_CN' },
        { id: 'templateParameterKeys', label: '正文参数顺序（逗号分隔）', type: 'text', placeholder: 'po_number,supplier_name,message' },
      ],
    }],
    actions: [
      { id: 'send_template', name: '发送模板消息', description: '向供应商已登记 WhatsApp 号码发送已批准模板。', inputs: [p('to', '收件号码', 'string', true), p('poNumber', 'PO 编号', 'string', true), p('supplierName', '供应商', 'string', true), p('message', '跟进内容', 'string', true)], outputs: [p('message_id', 'Meta Message ID', 'string'), p('accepted_at', '受理时间', 'string')], parameters: [], sideEffects: ['发送外部 WhatsApp 消息'], idempotent: false, risk: 'medium' },
    ],
  },
  {
    id: 'deepseek', version: 1, name: 'DeepSeek AI', description: '用于供应商回信结构化解析与采购上下文理解；连接测试会调用官方余额接口验证密钥与可用额度。', icon: 'brain-circuit', vendor: 'DeepSeek', category: 'AI 模型', runtime: 'builtin', distribution: 'builtin', tags: ['DeepSeek', 'AI', '供应商回信'],
    credentials: [{ type: 'deepseekApiKey', required: true, scopes: ['chat.completions', 'user.balance'] }],
    credentialSchemas: [{ type: 'deepseekApiKey', name: 'DeepSeek API', testable: true, fields: [
      { id: 'apiKey', label: 'API 密钥', type: 'password', required: true, secret: true, placeholder: 'sk-...' },
    ] }],
    actions: [{ id: 'balance.get', name: '验证账户可用性', description: '读取 DeepSeek 官方账户余额可用状态，不返回密钥或具体金额。', inputs: [], outputs: [p('available', '是否可用', 'boolean'), p('currencies', '币种', 'array')], parameters: [], sideEffects: [], idempotent: true, risk: 'read' }],
  },
  {
    id: 'erp', version: 1, name: 'ERP', description: '采购需求、询价、采购单与发票连接器。', icon: 'database', vendor: 'Readywork', category: 'ERP', runtime: 'builtin', distribution: 'builtin', tags: ['Odoo', '采购', '应付'],
    credentials: [{ type: 'erpCredential', required: true, scopes: ['procurement.read', 'procurement.write'] }],
    credentialSchemas: [{ type: 'erpCredential', name: 'ERP 连接', fields: [
      { id: 'baseUrl', label: '服务地址', type: 'text', required: true },
      { id: 'database', label: '账套 / 数据库', type: 'text', required: true },
      { id: 'apiKey', label: 'API Key', type: 'password', required: true, secret: true },
    ] }],
    actions: [
      { id: 'po.get', name: '读取采购单', description: '查询采购单事实。', inputs: [p('poId', '采购单号', 'string', true)], outputs: [p('po', '采购单', 'object')], parameters: [], sideEffects: [], idempotent: true, risk: 'read' },
      { id: 'po.update', name: '更新采购单', description: '更新交期等被授权字段。', inputs: [p('poId', '采购单号', 'string', true), p('field', '字段', 'string', true), p('value', '新值', 'any', true)], outputs: [p('po', '更新后采购单', 'object')], parameters: [], sideEffects: ['写 ERP'], idempotent: true, risk: 'high' },
      { id: 'po.create_draft', name: '创建采购单草稿', description: '根据已冻结的采购单快照在 Odoo 创建 draft 采购单。', inputs: [p('correlationKey', '业务关联键', 'string', true), p('partnerId', 'Odoo 供应商 ID', 'number', true), p('currencyCode', '币种', 'string', true), p('lines', '采购行', 'array', true)], outputs: [p('id', 'Odoo 采购单 ID', 'number'), p('name', '采购单名称', 'string'), p('state', '状态', 'string'), p('correlationKey', '业务关联键', 'string'), p('replayed', '幂等回放', 'boolean')], parameters: [], sideEffects: ['写 ERP'], idempotent: true, risk: 'high' },
      { id: 'rfq.create', name: '创建询价', description: '在 ERP 建立询价单。', inputs: [p('rfqId', '询价单号', 'string', true), p('item', '物料', 'string', true), p('qty', '数量', 'number', true)], outputs: [p('rfq', '询价单', 'object')], parameters: [], sideEffects: ['写 ERP'], idempotent: true, risk: 'medium' },
      { id: 'rfq.award', name: '写入定标', description: '写入中标供应商。', inputs: [p('rfqId', '询价单号', 'string', true), p('supplierId', '供应商 ID', 'string', true)], outputs: [p('rfq', '定标结果', 'object')], parameters: [], sideEffects: ['写 ERP'], idempotent: true, risk: 'high' },
      { id: 'invoice.update', name: '应付审核回写', description: '回写发票核对状态，不执行付款。', inputs: [p('invoiceId', '发票 ID', 'string', true), p('status', '审核状态', 'string', true)], outputs: [p('invoice', '发票', 'object')], parameters: [], sideEffects: ['写 ERP'], idempotent: true, risk: 'high' },
    ],
  },
  {
    id: 'excel', version: 1, name: '采购台账', description: '读取或追加采购业务台账。', icon: 'file-spreadsheet', vendor: 'Readywork', category: '文件', runtime: 'builtin', distribution: 'builtin', tags: ['Excel', '台账'], credentials: [],
    actions: [
      { id: 'appendRow', name: '追加台账', description: '幂等追加一条业务记录。', inputs: [p('sheet', '工作表', 'string', true), p('row', '行数据', 'array', true)], outputs: [p('row_index', '行号', 'number')], parameters: [], sideEffects: ['写业务文件'], idempotent: true, risk: 'low' },
      { id: 'read', name: '读取台账', description: '读取工作表数据。', inputs: [p('sheet', '工作表', 'string', true)], outputs: [p('rows', '行数据', 'array')], parameters: [], sideEffects: [], idempotent: true, risk: 'read' },
    ],
  },
  {
    id: 'http', version: 1, name: 'HTTP 请求', description: '通用 HTTP API 连接器；在隔离子进程中运行，并强制配置允许访问的主机。', icon: 'globe', vendor: 'Readywork', category: '通用', runtime: 'local_process', distribution: 'official', tags: ['REST', 'API', '隔离运行'], credentials: [{ type: 'httpCredential', required: false, scopes: ['http.request'] }],
    credentialSchemas: [{ type: 'httpCredential', name: 'HTTP 鉴权', fields: [
      { id: 'authType', label: '鉴权方式', type: 'select', defaultValue: 'none', options: [{ label: '无', value: 'none' }, { label: 'Bearer Token', value: 'bearer' }, { label: 'Basic Auth', value: 'basic' }] },
      { id: 'token', label: 'Token', type: 'password', secret: true },
      { id: 'username', label: '用户名', type: 'text' },
      { id: 'password', label: '密码', type: 'password', secret: true },
    ] }],
    actions: [{ id: 'request', name: '发送请求', description: '向允许列表中的服务发送 HTTP 请求。', inputs: [p('url', 'URL', 'string', true), p('method', '方法', 'string', true), p('headers', '请求头', 'object'), p('body', '请求体', 'any')], outputs: [p('status', '状态码', 'number'), p('headers', '响应头', 'object'), p('body', '响应体', 'any')], parameters: [], sideEffects: ['调用外部 API'], idempotent: false, risk: 'high' }],
  },
  {
    id: 'webhook', version: 1, name: 'Webhook', description: '接收已签名的外部事件。', icon: 'webhook', vendor: 'Readywork', category: '通用', runtime: 'builtin', distribution: 'official', tags: ['事件', '回调'], credentials: [{ type: 'webhookSecret', required: true, scopes: ['webhook.receive'] }],
    credentialSchemas: [{ type: 'webhookSecret', name: 'Webhook 签名', fields: [{ id: 'secret', label: '签名密钥', type: 'password', required: true, secret: true }] }],
    actions: [{ id: 'receive', name: '接收事件', description: '校验签名后产生平台事件。', inputs: [p('headers', '请求头', 'object'), p('payload', '事件载荷', 'object', true)], outputs: [p('event', '标准事件', 'event')], parameters: [], sideEffects: [], idempotent: true, risk: 'low' }],
  },
  {
    id: 'sap', version: 1, name: 'SAP S/4HANA', description: '采购订单、供应商、库存和收货业务插件。', icon: 'boxes', vendor: 'Readywork', category: 'ERP', runtime: 'local_process', distribution: 'official', tags: ['SAP', 'OData', 'RFC'],
    credentials: [{ type: 'sapCredential', required: true, scopes: ['procurement.read', 'procurement.write'] }],
    credentialSchemas: [{ type: 'sapCredential', name: 'SAP 连接', fields: [{ id: 'baseUrl', label: '服务地址', type: 'text', required: true }, { id: 'client', label: 'Client', type: 'text', required: true }, { id: 'username', label: '用户名', type: 'text', required: true }, { id: 'password', label: '密码', type: 'password', required: true, secret: true }] }],
    actions: [{ id: 'po.get', name: '读取采购单', description: '读取 SAP 采购订单。', inputs: [p('poId', '采购单号', 'string', true)], outputs: [p('po', '采购单', 'object')], parameters: [], sideEffects: [], idempotent: true, risk: 'read' }],
  },
  {
    id: 'kingdee', version: 1, name: '金蝶云', description: '金蝶云星空 / KIS 采购与库存插件。', icon: 'boxes', vendor: 'Readywork', category: 'ERP', runtime: 'local_process', distribution: 'official', tags: ['金蝶', '云星空', 'KIS'],
    credentials: [{ type: 'kingdeeCredential', required: true, scopes: ['procurement.read', 'procurement.write'] }],
    credentialSchemas: [{ type: 'kingdeeCredential', name: '金蝶连接', fields: [{ id: 'baseUrl', label: '服务地址', type: 'text', required: true }, { id: 'accountId', label: '账套 ID', type: 'text', required: true }, { id: 'appId', label: 'App ID', type: 'text', required: true }, { id: 'appSecret', label: 'App Secret', type: 'password', required: true, secret: true }] }],
    actions: [{ id: 'po.get', name: '读取采购单', description: '读取金蝶采购订单。', inputs: [p('poId', '采购单号', 'string', true)], outputs: [p('po', '采购单', 'object')], parameters: [], sideEffects: [], idempotent: true, risk: 'read' }],
  },
  {
    id: 'yonyou', version: 1, name: '用友', description: '用友 U8 / NC / YonSuite 采购业务插件。', icon: 'boxes', vendor: 'Readywork', category: 'ERP', runtime: 'local_process', distribution: 'official', tags: ['用友', 'U8', 'NC', 'YonSuite'],
    credentials: [{ type: 'yonyouCredential', required: true, scopes: ['procurement.read', 'procurement.write'] }],
    credentialSchemas: [{ type: 'yonyouCredential', name: '用友连接', fields: [{ id: 'baseUrl', label: '服务地址', type: 'text', required: true }, { id: 'appKey', label: 'App Key', type: 'text', required: true }, { id: 'appSecret', label: 'App Secret', type: 'password', required: true, secret: true }] }],
    actions: [{ id: 'po.get', name: '读取采购单', description: '读取用友采购订单。', inputs: [p('poId', '采购单号', 'string', true)], outputs: [p('po', '采购单', 'object')], parameters: [], sideEffects: [], idempotent: true, risk: 'read' }],
  },
  ...([
    ['wecom', '企业微信', '企业微信消息、审批与通讯录插件。', '协同', 'wecomCredential', ['corpId', 'agentId', 'secret']],
    ['dingtalk', '钉钉', '钉钉工作通知与 OA 审批插件。', '协同', 'dingtalkCredential', ['clientId', 'clientSecret']],
    ['feishu', '飞书', '飞书消息、审批与多维表格插件。', '协同', 'feishuCredential', ['appId', 'appSecret']],
    ['wms', 'WMS', '收货、入库、库存与发运事件插件。', '制造系统', 'wmsCredential', ['baseUrl', 'apiKey']],
    ['mes', 'MES', '生产计划、工单、产能与质量事件插件。', '制造系统', 'mesCredential', ['baseUrl', 'apiKey']],
    ['database', '数据库', 'PostgreSQL、MySQL 与 SQL Server 数据访问插件。', '数据', 'databaseCredential', ['host', 'port', 'database', 'username', 'password']],
  ] as Array<[string, string, string, string, string, string[]]>).map(([id, name, description, category, credentialType, fieldIds]) => ({
    id, version: 1, name, description, icon: 'plug', vendor: 'Readywork', category, runtime: 'local_process' as const, distribution: 'official' as const, tags: [name, '插件'],
    credentials: [{ type: credentialType, required: true, scopes: [`${id}.read`, `${id}.write`] }],
    credentialSchemas: [{ type: credentialType, name: `${name}连接`, fields: fieldIds.map((fieldId) => ({ id: fieldId, label: ({ corpId: '企业 ID', agentId: 'Agent ID', secret: 'Secret', clientId: 'Client ID', clientSecret: 'Client Secret', appId: 'App ID', appSecret: 'App Secret', baseUrl: '服务地址', apiKey: 'API Key', host: '主机', port: '端口', database: '数据库', username: '用户名', password: '密码' } as Record<string, string>)[fieldId] ?? fieldId, type: ['secret', 'clientSecret', 'appSecret', 'apiKey', 'password'].includes(fieldId) ? 'password' as const : fieldId === 'port' ? 'number' as const : 'text' as const, required: true, secret: ['secret', 'clientSecret', 'appSecret', 'apiKey', 'password'].includes(fieldId) })) }],
    actions: [{ id: 'execute', name: '执行业务动作', description: `通过${name}插件执行已授权动作。`, inputs: [p('payload', '输入', 'object', true)], outputs: [p('result', '结果', 'object')], parameters: [], sideEffects: [`调用${name}`], idempotent: false, risk: 'high' as const }],
  })),
];

export type ConnectorInstallationStatus = 'available' | 'installing' | 'installed' | 'disabled' | 'failed';
export type ConnectorCredentialStatus = 'untested' | 'connected' | 'partial' | 'failed';
export type ConnectorImplementationMode = 'real' | 'reference';
export type ConnectorInstallationView = ConnectorDescriptor & {
  status: ConnectorInstallationStatus;
  runtimeHealthy: boolean;
  credentialReady: boolean;
  externalVerified: boolean;
  implementationMode: ConnectorImplementationMode;
  /** 兼容字段：只有真实外部连接已验证时为 true。 */
  healthy: boolean;
  credentialCount: number;
  healthMessage?: string;
  installedAt?: string;
  updatedAt?: string;
  error?: string;
};
export interface ConnectorCredentialView { id: string; connectorId: string; credentialType: string; name: string; status: ConnectorCredentialStatus; lastTestedAt?: string; lastError?: string; createdAt: string; updatedAt: string }
export interface ConnectorEventView { seq: number; connectorId: string; eventType: string; status: string; message: string; metadata: Record<string, unknown>; createdAt: string }

class ToolConnectorAdapter implements ConnectorAdapter {
  constructor(private connectorId: string, private tools: ToolRegistry) {}

  async execute(action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorExecutionResult> {
    if (this.connectorId === 'email') {
      if (Object.keys(context.credentials).length === 0) return { ok: false, error: '企业邮箱凭据不可用，已阻止外部动作' };
      if (action !== 'send' && action !== 'inbox.list') return { ok: false, error: `企业邮箱真实适配器尚未实现动作: ${action}` };
    }
    if (this.connectorId === 'email' && action === 'send') {
      const username = String(context.credentials['username'] ?? context.credentials['user'] ?? '');
      const authorizationCode = String(context.credentials['authorizationCode'] ?? context.credentials['password'] ?? context.credentials['pass'] ?? '');
      const host = String(context.credentials['smtpHost'] ?? 'smtp.163.com');
      const port = Number(context.credentials['smtpPort'] ?? 465);
      if (!username || !authorizationCode) return { ok: false, error: '邮箱凭据缺少邮箱地址或授权码' };
      const attachments = emailAttachments(input['attachments']);
      const sent = await sendMail(host, port, username, authorizationCode, {
        to: String(input['to'] ?? ''),
        ...(typeof input['fromName'] === 'string' && input['fromName'].trim() ? { fromName: input['fromName'].trim() } : {}),
        subject: String(input['subject'] ?? ''),
        body: String(input['body'] ?? ''),
        attachments,
      });
      return sent.ok ? { ok: true, output: {
        message_id: sent.messageId, sent_at: new Date().toISOString(), message: sent.message,
        ...(typeof input['fromName'] === 'string' && input['fromName'].trim() ? { from_name: input['fromName'].trim() } : {}),
        attachments: attachments.map((attachment) => ({ filename: attachment.filename, contentType: attachment.contentType, sizeBytes: attachment.content.byteLength })),
      } } : { ok: false, error: sent.message };
    }
    if (this.connectorId === 'email' && action === 'inbox.list') {
      const username = String(context.credentials['username'] ?? context.credentials['user'] ?? '');
      const authorizationCode = String(context.credentials['authorizationCode'] ?? context.credentials['password'] ?? context.credentials['pass'] ?? '');
      const client = await ImapClient.connect({ host: String(context.credentials['imapHost'] ?? 'imap.163.com'), port: Number(context.credentials['imapPort'] ?? 993), user: username, pass: authorizationCode, secure: context.credentials['secure'] !== false });
      try {
        const messages = await client.fetchUnseen();
        return { ok: true, output: { messages } };
      } finally {
        await client.logout();
      }
    }
    if (this.connectorId === 'whatsapp') {
      if (Object.keys(context.credentials).length === 0) return { ok: false, error: 'WhatsApp Business 凭据不可用，已阻止外部动作' };
      if (action !== 'send_template') return { ok: false, error: `WhatsApp 真实适配器尚未实现动作: ${action}` };
      try {
        const sent = await new WhatsAppCloudApiClient(context.credentials).sendTemplate({
          to: String(input['to'] ?? ''),
          poNumber: String(input['poNumber'] ?? ''),
          supplierName: String(input['supplierName'] ?? ''),
          message: String(input['message'] ?? ''),
          idempotencyKey: context.idempotencyKey,
        }, context.timeoutMs);
        return { ok: true, output: { message_id: sent.messageId, accepted_at: sent.acceptedAt, delivery_status: 'accepted' } };
      } catch (error) { return { ok: false, error: connectorErrorMessage(error) }; }
    }
    if (this.connectorId === 'deepseek') {
      if (action !== 'balance.get') return { ok: false, error: `DeepSeek 连接器不支持动作: ${action}` };
      try {
        const health = await deepSeekAccountHealth(context.credentials);
        return { ok: true, output: { available: true, currencies: health.currencies } };
      } catch (error) {
        return { ok: false, error: connectorErrorMessage(error) };
      }
    }
    if (this.connectorId === 'erp') {
      if (Object.keys(context.credentials).length === 0) return { ok: false, error: 'ERP 凭据不可用，已阻止外部动作' };
      const odoo = odooClientFromCredentials(context.credentials);
      if (action === 'po.get') {
        const poId = String(input['poId'] ?? input['id'] ?? '');
        if (!poId) return { ok: false, error: '采购单号必填' };
        const po = await odoo.readPO(poId);
        return po ? { ok: true, output: { po, source: 'odoo' } } : { ok: false, error: `Odoo 未找到采购单: ${poId}` };
      }
      if (action === 'po.update') {
        const poId = String(input['poId'] ?? input['id'] ?? '');
        const field = String(input['field'] ?? '');
        if (!poId) return { ok: false, error: '采购单号必填' };
        if (!['promiseDate', 'date_planned'].includes(field)) return { ok: false, error: `Odoo 当前只允许更新承诺交期，不能修改字段: ${field}` };
        const write = await odoo.updateETA(poId, String(input['value'] ?? ''));
        const po = await odoo.readPO(poId);
        return { ok: true, output: { po, write, source: 'odoo' } };
      }
      if (action === 'po.create_draft') {
        const draftInput = odooPurchaseOrderDraftInput(input);
        const draft = await odoo.createPurchaseOrderDraft(draftInput);
        return { ok: true, output: {
          id: draft.id,
          name: draft.name,
          state: draft.state,
          correlationKey: draftInput.correlationKey,
          replayed: draft.replayed,
        } };
      }
      if (action === 'invoice.update') {
        const invoiceId = Number(input['invoiceId'] ?? input['id']);
        if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) return { ok: false, error: '发票 ID 必须是正整数' };
        const update = invoiceMatchUpdate(input);
        const invoice = await odoo.updateInvoiceMatch(invoiceId, update);
        return { ok: true, output: { invoice, update, source: 'odoo' } };
      }
      return { ok: false, error: `ERP 真实适配器尚未实现动作: ${action}` };
    }
    const result = await this.tools.execute(this.connectorId, action, input, {
      employeeId: context.employeeId,
      taskId: context.runId,
      businessObjectId: String(input['businessObjectId'] ?? input['objectId'] ?? context.runId),
    });
    if (!result.ok) return { ok: false, error: connectorErrorMessage(result.error ?? 'Connector 执行失败'), cost: result.cost };
    const raw = result.data ?? {};
    const output = this.connectorId === 'email' && action === 'send'
      ? { ...raw, message_id: raw['messageId'], sent_at: new Date().toISOString() }
      : raw;
    return { ok: true, output: redactSensitiveValue(output) as Record<string, unknown>, cost: result.cost };
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    if (this.connectorId === 'email' || this.connectorId === 'whatsapp' || this.connectorId === 'deepseek' || this.connectorId === 'erp') return { ok: true, message: '真实适配器已加载' };
    return { ok: Boolean(this.tools.get(this.connectorId)), message: this.tools.get(this.connectorId) ? '运行正常' : '底层工具未注册' };
  }
}

function invoiceMatchUpdate(input: Record<string, unknown>): { matchResult?: 'exact_match' | 'within_tolerance' | 'approval_required' | 'severe_exception'; approvalStatus?: 'pending' | 'approved' | 'rejected'; payableStatus?: 'payable' | 'hold' | 'not_payable'; holdReason?: string } {
  const matchResult = input['matchResult'];
  const approvalStatus = input['approvalStatus'];
  const payableStatus = input['payableStatus'];
  const holdReason = input['holdReason'];
  if (typeof matchResult === 'string' && !['exact_match', 'within_tolerance', 'approval_required', 'severe_exception'].includes(matchResult)) throw new Error('invoice.update 的 matchResult 非法');
  if (typeof approvalStatus === 'string' && !['pending', 'approved', 'rejected'].includes(approvalStatus)) throw new Error('invoice.update 的 approvalStatus 非法');
  if (typeof payableStatus === 'string' && !['payable', 'hold', 'not_payable'].includes(payableStatus)) throw new Error('invoice.update 的 payableStatus 非法');
  if (typeof holdReason === 'string' && holdReason.length > 1_000) throw new Error('invoice.update 的 holdReason 不能超过 1000 个字符');
  const update = {
    ...(typeof matchResult === 'string' ? { matchResult: matchResult as 'exact_match' | 'within_tolerance' | 'approval_required' | 'severe_exception' } : {}),
    ...(typeof approvalStatus === 'string' ? { approvalStatus: approvalStatus as 'pending' | 'approved' | 'rejected' } : {}),
    ...(typeof payableStatus === 'string' ? { payableStatus: payableStatus as 'payable' | 'hold' | 'not_payable' } : {}),
    ...(typeof holdReason === 'string' ? { holdReason } : {}),
  };
  if (Object.keys(update).length === 0) throw new Error('invoice.update 至少需要一个状态字段');
  return update;
}

class WebhookConnectorAdapter implements ConnectorAdapter {
  async execute(action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorExecutionResult> {
    if (action !== 'receive') return { ok: false, error: `Webhook 不支持动作: ${action}` };
    const secret = String(context.credentials['secret'] ?? '');
    if (!secret) return { ok: false, error: 'Webhook 凭据缺少签名密钥' };

    const rawBody = typeof input['rawBody'] === 'string' ? input['rawBody'] : JSON.stringify(input['payload'] ?? {});
    const headers = input['headers'] && typeof input['headers'] === 'object' ? input['headers'] as Record<string, unknown> : {};
    const signature = String(input['signature'] ?? headers['x-readywork-signature'] ?? headers['X-Readywork-Signature'] ?? '').replace(/^sha256=/i, '').trim();
    if (!/^[a-f0-9]{64}$/i.test(signature)) return { ok: false, error: 'Webhook 签名缺失或格式错误' };

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    const receivedBuffer = Buffer.from(signature, 'hex');
    if (expectedBuffer.length !== receivedBuffer.length || !timingSafeEqual(expectedBuffer, receivedBuffer)) {
      return { ok: false, error: 'Webhook 签名验证失败' };
    }

    const payload = input['payload'] && typeof input['payload'] === 'object' ? input['payload'] as Record<string, unknown> : {};
    return {
      ok: true,
      output: {
        event: {
          type: String(payload['type'] ?? payload['eventType'] ?? 'connector.webhook.received'),
          payload,
          receivedAt: new Date().toISOString(),
        },
      },
    };
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: '事件接收器运行正常' };
  }
}

export class ConnectorControlPlane {
  private registry = new RuntimeConnectorRegistry();
  private vault?: CredentialVault;

  constructor(private db: DatabaseSync | undefined, private tools: ToolRegistry, private tenantId: string) {
    if (this.db) initializeControlPlaneSchema(this.db);
    const secret = process.env['READYWORK_CREDENTIAL_KEY'];
    if (secret) this.vault = new CredentialVault(secret);
    const defaultInstalled = new Set(['email', 'whatsapp', 'deepseek', 'erp', 'excel']);
    for (const connector of CONNECTOR_CATALOG) {
      const saved = this.installation(connector.id, connector.version);
      if (saved?.status === 'disabled') continue;
      if (!defaultInstalled.has(connector.id) && saved?.status !== 'installed') continue;
      try {
        this.registry.register(connector, this.adapterFor(connector, saved?.config ?? {}));
        this.recordInstallation(connector, 'installed', saved?.config ?? {});
      } catch (error) {
        const message = connectorErrorMessage(error);
        this.recordInstallation(connector, 'failed', saved?.config ?? {}, message);
        this.recordEvent(connector.id, 'restore_failed', 'failed', message, { version: connector.version });
      }
    }
  }

  async list(): Promise<ConnectorInstallationView[]> {
    const installed = new Set(this.registry.list().map((item) => `${item.id}@${item.version}`));
    return Promise.all(CONNECTOR_CATALOG.map(async (connector) => {
      const isInstalled = installed.has(`${connector.id}@${connector.version}`);
      const saved = this.installation(connector.id, connector.version);
      const status = isInstalled ? 'installed' : saved?.status ?? 'available';
      const credentialCount = this.credentialCount(connector.id);
      const implementationMode = this.implementationMode(connector);
      const credential = this.credentialReadiness(connector);
      if (!isInstalled) return {
        ...connector,
        status,
        healthy: false,
        runtimeHealthy: false,
        credentialReady: credential.ready,
        externalVerified: false,
        implementationMode,
        credentialCount,
        healthMessage: saved?.error ?? (status === 'disabled' ? '已停用' : '尚未安装运行时'),
        installedAt: saved?.installedAt,
        updatedAt: saved?.updatedAt,
        error: saved?.error,
      };
      const health = await this.registry.health(connector.id, connector.version);
      const runtimeHealthy = health.ok;
      const hasExternalVerificationContract = connector.credentials.some((item) => item.required);
      const externalVerified = implementationMode === 'real' && runtimeHealthy && hasExternalVerificationContract && credential.ready;
      const healthMessage = !runtimeHealthy
        ? health.message ?? 'Connector 运行时异常'
        : implementationMode === 'reference'
          ? '参考实现已加载；不代表外部系统已连接'
          : !hasExternalVerificationContract
            ? '隔离运行时已就绪；尚未验证任何外部目标'
            : credential.message ?? health.message ?? '外部连接已验证';
      return {
        ...connector,
        status: 'installed' as const,
        healthy: externalVerified,
        runtimeHealthy,
        credentialReady: credential.ready,
        externalVerified,
        implementationMode,
        credentialCount,
        healthMessage,
        installedAt: saved?.installedAt,
        updatedAt: saved?.updatedAt,
      };
    }));
  }

  async install(connectorId: string, config: Record<string, unknown> = {}): Promise<ConnectorInstallationView> {
    const descriptor = CONNECTOR_CATALOG.find((item) => item.id === connectorId);
    if (!descriptor) throw new Error(`Connector 不存在: ${connectorId}`);
    this.recordInstallation(descriptor, 'installing', config);
    try {
      await this.registry.unregister(descriptor.id, descriptor.version);
      this.registry.register(descriptor, this.adapterFor(descriptor, config));
      const health = await this.registry.health(descriptor.id, descriptor.version);
      if (!health.ok) throw new Error(health.message ?? 'Connector 健康检查失败');
      this.recordInstallation(descriptor, 'installed', config);
      this.recordEvent(descriptor.id, 'installed', 'success', `${descriptor.name} 已安装`, { version: descriptor.version, runtime: descriptor.runtime });
    } catch (error) {
      await this.registry.unregister(descriptor.id, descriptor.version);
      this.recordInstallation(descriptor, 'failed', config, connectorErrorMessage(error));
      this.recordEvent(descriptor.id, 'install_failed', 'failed', connectorErrorMessage(error), { version: descriptor.version });
      throw error;
    }
    return (await this.list()).find((item) => item.id === connectorId)!;
  }

  async disable(connectorId: string): Promise<ConnectorInstallationView> {
    const descriptor = CONNECTOR_CATALOG.find((item) => item.id === connectorId);
    if (!descriptor) throw new Error(`Connector 不存在: ${connectorId}`);
    const saved = this.installation(descriptor.id, descriptor.version);
    await this.registry.unregister(descriptor.id, descriptor.version);
    this.recordInstallation(descriptor, 'disabled', saved?.config ?? {});
    this.recordEvent(descriptor.id, 'disabled', 'success', `${descriptor.name} 已停用`);
    return (await this.list()).find((item) => item.id === connectorId)!;
  }

  async enable(connectorId: string): Promise<ConnectorInstallationView> {
    const descriptor = CONNECTOR_CATALOG.find((item) => item.id === connectorId);
    if (!descriptor) throw new Error(`Connector 不存在: ${connectorId}`);
    return this.install(connectorId, this.installation(descriptor.id, descriptor.version)?.config ?? {});
  }

  async upgrade(connectorId: string, config: Record<string, unknown> = {}): Promise<ConnectorInstallationView> {
    return this.install(connectorId, { ...(this.installation(connectorId, 1)?.config ?? {}), ...config });
  }

  async uninstall(connectorId: string): Promise<void> {
    const descriptor = CONNECTOR_CATALOG.find((item) => item.id === connectorId);
    if (!descriptor) throw new Error(`Connector 不存在: ${connectorId}`);
    await this.registry.unregister(descriptor.id, descriptor.version);
    this.db?.prepare('DELETE FROM control_connector_installations WHERE tenant_id=? AND connector_id=?').run(this.tenantId, connectorId);
    this.recordEvent(descriptor.id, 'uninstalled', 'success', `${descriptor.name} 已卸载`);
  }

  async execute(connectorId: string, action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorExecutionResult> {
    if (context.tenantId !== this.tenantId) throw new Error('Connector 执行租户与控制面不一致');
    const result = await this.registry.execute(connectorId, 1, action, input, context);
    return result.ok
      ? { ...result, output: redactSensitiveValue(result.output) as Record<string, unknown> }
      : { ...result, error: connectorErrorMessage(result.error ?? 'Connector 执行失败') };
  }

  /**
   * 只读恢复核验。ERP 写入在保留租约过期后绝不直接重放：先确认目标状态，
   * 不能确认则由 Action Gateway 固化为人工对账状态。
   */
  async reconcile(connectorId: string, action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<{ confirmed: boolean; output?: Record<string, unknown> }> {
    if (context.tenantId !== this.tenantId || connectorId !== 'erp') return { confirmed: false };
    const credentials = context.credentials;
    if (Object.keys(credentials).length === 0) return { confirmed: false };
    try {
      const odoo = odooClientFromCredentials(credentials);
      if (action === 'po.update') {
        const poId = String(input['poId'] ?? input['id'] ?? '');
        const wanted = String(input['value'] ?? input['promiseDate'] ?? '').slice(0, 10);
        const po = poId ? await odoo.readPO(poId) : null;
        return po?.promiseDate?.slice(0, 10) === wanted ? { confirmed: true, output: { po, source: 'odoo', reconciled: true } } : { confirmed: false };
      }
      if (action === 'invoice.update') {
        const invoiceId = Number(input['invoiceId'] ?? input['id']);
        if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) return { confirmed: false };
        const update = invoiceMatchUpdate(input);
        const confirmed = await odoo.verifyInvoiceMatch(invoiceId, update);
        return confirmed ? { confirmed: true, output: { invoiceId, update, source: 'odoo', reconciled: true } } : { confirmed: false };
      }
    } catch {
      // ActionGateway must not leak integration errors from an interrupted write.
    }
    return { confirmed: false };
  }

  async receiveWebhook(credentialId: string, input: { rawBody: string; payload: Record<string, unknown>; headers: Record<string, unknown>; signature?: string }): Promise<ConnectorExecutionResult> {
    const credential = this.listCredentials().find((item) => item.id === credentialId && item.connectorId === 'webhook');
    const credentials = credential ? this.getCredential(credentialId) : undefined;
    if (!credential || !credentials) return { ok: false, error: 'Webhook 凭据不存在或无法解密' };
    try {
      const result = await this.execute('webhook', 'receive', input, {
        tenantId: this.tenantId,
        employeeId: 'system:webhook',
        runId: `webhook:${Date.now()}`,
        nodeRunId: `webhook-node:${Date.now()}`,
        idempotencyKey: createHmac('sha256', String(credentials['secret'] ?? '')).update(input.rawBody).digest('hex'),
        credentials,
        timeoutMs: 5_000,
      });
      this.recordEvent('webhook', 'webhook_received', result.ok ? 'success' : 'failed', result.ok ? 'Webhook 事件签名验证通过' : (result.error ?? 'Webhook 接收失败'), { credentialId });
      return result;
    } catch (error) {
      const message = connectorErrorMessage(error);
      this.recordEvent('webhook', 'webhook_received', 'failed', message, { credentialId });
      return { ok: false, error: message };
    }
  }

  credentialStatus(): { encryptedPersistence: boolean; count: number } {
    const row = this.db?.prepare('SELECT COUNT(*) AS count FROM control_credentials WHERE tenant_id = ?').get(this.tenantId) as { count: number } | undefined;
    return { encryptedPersistence: Boolean(this.vault && this.db), count: row?.count ?? 0 };
  }

  listCredentials(): ConnectorCredentialView[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT id, connector_id, credential_type, name, status, last_tested_at, last_error, created_at, updated_at FROM control_credentials WHERE tenant_id = ? ORDER BY updated_at DESC').all(this.tenantId) as Array<{ id: string; connector_id: string; credential_type: string; name: string; status: ConnectorCredentialStatus; last_tested_at: string | null; last_error: string | null; created_at: string; updated_at: string }>;
    return rows.map((row) => {
      const decryptable = this.getCredential(row.id) !== undefined;
      const status: ConnectorCredentialStatus = decryptable ? row.status : 'failed';
      const lastError = decryptable ? row.last_error : '凭据无法解密，请重新配置';
      return { id: row.id, connectorId: row.connector_id, credentialType: row.credential_type, name: row.name, status, ...(row.last_tested_at ? { lastTestedAt: row.last_tested_at } : {}), ...(lastError ? { lastError: connectorErrorMessage(lastError) } : {}), createdAt: row.created_at, updatedAt: row.updated_at };
    });
  }

  putCredential(input: { id: string; connectorId: string; credentialType: string; name: string; value: Record<string, import('@readywork/graph-runtime').JsonValue> }): void {
    if (!this.db || !this.vault) throw new Error('凭据加密未启用，请配置 READYWORK_CREDENTIAL_KEY（至少 24 个字符）');
    const encrypted = this.vault.encrypt(input.value);
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO control_credentials (tenant_id, id, connector_id, credential_type, name, encrypted_json, status, last_tested_at, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'untested', NULL, NULL, ?, ?) ON CONFLICT(tenant_id, id) DO UPDATE SET connector_id = excluded.connector_id, credential_type = excluded.credential_type, name = excluded.name, encrypted_json = excluded.encrypted_json, status = 'untested', last_tested_at = NULL, last_error = NULL, updated_at = excluded.updated_at").run(this.tenantId, input.id, input.connectorId, input.credentialType, input.name, JSON.stringify(encrypted), now, now);
    this.recordEvent(input.connectorId, 'credential_saved', 'success', `${input.name} 已加密保存`, { credentialId: input.id, credentialType: input.credentialType });
  }

  deleteCredential(id: string): boolean {
    if (!this.db) return false;
    const item = this.listCredentials().find((credential) => credential.id === id);
    const result = this.db.prepare('DELETE FROM control_credentials WHERE tenant_id = ? AND id = ?').run(this.tenantId, id);
    if (item && Number(result.changes) > 0) this.recordEvent(item.connectorId, 'credential_deleted', 'success', `${item.name} 已删除`, { credentialId: id });
    return Number(result.changes) > 0;
  }

  async testCredential(id: string): Promise<{ ok: boolean; connectorId: string; credentialId: string; message: string; checks: Array<{ name: string; ok: boolean; message: string }> }> {
    const item = this.listCredentials().find((credential) => credential.id === id);
    const value = this.getCredential(id);
    if (!item || !value) throw new Error('凭据不存在或无法解密');
    const checks: Array<{ name: string; ok: boolean; message: string }> = [];
    try {
      if (item.connectorId === 'email') {
        const username = String(value['username'] ?? value['user'] ?? '');
        const authorizationCode = String(value['authorizationCode'] ?? value['password'] ?? value['pass'] ?? '');
        if (!username || !authorizationCode) throw new Error('邮箱地址和授权码必填');
        const sent = await sendMail(String(value['smtpHost'] ?? 'smtp.163.com'), Number(value['smtpPort'] ?? 465), username, authorizationCode, {
          to: username,
          subject: `Readywork 邮箱连接测试 ${new Date().toISOString()}`,
          body: '这是一封来自 Readywork Connector 控制台的连接测试邮件。',
        });
        checks.push({ name: 'SMTP 发信', ok: sent.ok, message: sent.ok ? '测试邮件已发送' : connectorErrorMessage(sent.message) });
        if (!sent.ok) throw new Error(sent.message);
        const imap = await ImapClient.connect({ host: String(value['imapHost'] ?? 'imap.163.com'), port: Number(value['imapPort'] ?? 993), user: username, pass: authorizationCode, secure: value['secure'] !== false });
        try {
          const unseen = await imap.fetchUnseenUids();
          checks.push({ name: 'IMAP 收件', ok: true, message: `连接成功，当前 ${unseen.length} 封未读邮件` });
        } finally {
          await imap.logout();
        }
      } else if (item.connectorId === 'erp') {
        const health = await odooClientFromCredentials(value).healthCheck();
        checks.push({ name: 'Odoo API', ok: health.ok, message: health.ok ? health.detail : connectorErrorMessage(health.detail) });
        if (!health.ok) throw new Error(health.detail);
      } else if (item.connectorId === 'whatsapp') {
        const health = await new WhatsAppCloudApiClient(value).healthCheck();
        checks.push({ name: 'Meta 发信号码', ok: true, message: String(health.profile['display_phone_number'] ?? health.profile['verified_name'] ?? '号码已验证') });
        checks.push({ name: '跟进模板', ok: true, message: `${String(health.template['name'])} / ${String(health.template['language'])} 已批准，${health.parameterCount} 个参数` });
      } else if (item.connectorId === 'deepseek') {
        await deepSeekAccountHealth(value);
        checks.push({ name: 'DeepSeek API', ok: true, message: '密钥有效且账户余额可用' });
      } else {
        const health = await this.registry.health(item.connectorId, 1);
        checks.push({ name: '运行时健康检查', ok: health.ok, message: health.ok ? (health.message ?? '连接正常') : connectorErrorMessage(health.message ?? '连接失败') });
        if (!health.ok) throw new Error(health.message ?? '连接失败');
      }
      const testedAt = new Date().toISOString();
      this.db?.prepare("UPDATE control_credentials SET status = 'connected', last_tested_at = ?, last_error = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?").run(testedAt, testedAt, this.tenantId, id);
      this.recordEvent(item.connectorId, 'credential_tested', 'success', `${item.name} 连接测试通过`, { credentialId: id, checks });
      return { ok: true, connectorId: item.connectorId, credentialId: id, message: '连接测试通过', checks };
    } catch (error) {
      const testedAt = new Date().toISOString();
      const message = connectorErrorMessage(error);
      const status: ConnectorCredentialStatus = checks.some((check) => check.ok) ? 'partial' : 'failed';
      this.db?.prepare('UPDATE control_credentials SET status = ?, last_tested_at = ?, last_error = ?, updated_at = ? WHERE tenant_id = ? AND id = ?').run(status, testedAt, message, testedAt, this.tenantId, id);
      this.recordEvent(item.connectorId, 'credential_tested', status, message, { credentialId: id, checks });
      return { ok: false, connectorId: item.connectorId, credentialId: id, message, checks };
    }
  }

  listEvents(limit = 100): ConnectorEventView[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT seq, connector_id, event_type, status, message, metadata_json, created_at FROM control_connector_events WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?').all(this.tenantId, Math.min(500, Math.max(1, limit))) as Array<{ seq: number; connector_id: string; event_type: string; status: string; message: string; metadata_json: string; created_at: string }>;
    return rows.map((row) => ({ seq: row.seq, connectorId: row.connector_id, eventType: row.event_type, status: row.status, message: connectorErrorMessage(row.message), metadata: redactSensitiveValue(JSON.parse(row.metadata_json)) as Record<string, unknown>, createdAt: row.created_at }));
  }

  getCredential(id: string): Record<string, import('@readywork/graph-runtime').JsonValue> | undefined {
    if (!this.db || !this.vault) return undefined;
    const row = this.db.prepare('SELECT encrypted_json FROM control_credentials WHERE tenant_id = ? AND id = ?').get(this.tenantId, id) as { encrypted_json: string } | undefined;
    if (!row) return undefined;
    try {
      return this.vault.decrypt(JSON.parse(row.encrypted_json) as EncryptedCredential);
    } catch {
      return undefined;
    }
  }

  private implementationMode(connector: ConnectorDescriptor): ConnectorImplementationMode {
    return connector.id === 'excel' ? 'reference' : 'real';
  }

  private credentialReadiness(connector: ConnectorDescriptor): { ready: boolean; message?: string } {
    const required = connector.credentials.filter((item) => item.required);
    if (required.length === 0) return { ready: true };
    const credentials = this.listCredentials().filter((item) => item.connectorId === connector.id);
    if (credentials.length === 0) return { ready: false, message: '运行时正常；尚未配置必需凭据' };
    const ready = required.every((requirement) => credentials.some((item) => item.credentialType === requirement.type && item.status === 'connected' && this.getCredential(item.id) !== undefined));
    if (ready) return { ready: true };
    if (credentials.some((item) => item.lastError?.includes('无法解密'))) return { ready: false, message: '运行时正常；凭据无法解密，请重新配置' };
    if (credentials.some((item) => item.status === 'partial')) return { ready: false, message: '运行时正常；凭据仅部分可用' };
    if (credentials.some((item) => item.status === 'failed')) return { ready: false, message: '运行时正常；凭据连接测试失败' };
    return { ready: false, message: '运行时正常；凭据尚未通过连接测试' };
  }

  private adapterFor(connector: ConnectorDescriptor, config: Record<string, unknown>): ConnectorAdapter {
    if (connector.id === 'webhook') return new WebhookConnectorAdapter();
    if (connector.runtime === 'builtin') return new ToolConnectorAdapter(connector.id, this.tools);
    if (connector.id === 'http' && connector.runtime === 'local_process') {
      const allowedHosts = Array.isArray(config['allowedHosts']) ? config['allowedHosts'].map(String).filter(Boolean) : [];
      if (allowedHosts.length === 0) throw new Error('HTTP Connector 安装时至少配置一个允许访问的主机');
      return new LocalProcessConnectorAdapter({
        id: 'http',
        version: String(connector.version),
        protocolVersion: 1,
        command: process.execPath,
        args: [fileURLToPath(new URL('./plugins/http-connector.mjs', import.meta.url)), JSON.stringify(allowedHosts)],
        timeoutMs: 30_000,
        maxConcurrency: 4,
      });
    }
    throw new Error(`${connector.name} 的 ${connector.runtime} 运行时尚未配置`);
  }

  private installation(connectorId: string, version: number): { status: ConnectorInstallationStatus; config: Record<string, unknown>; installedAt?: string; updatedAt?: string; error?: string } | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare('SELECT status,config_json,installed_at,updated_at,error FROM control_connector_installations WHERE tenant_id=? AND connector_id=? AND version=?').get(this.tenantId, connectorId, version) as { status: ConnectorInstallationStatus; config_json: string; installed_at: string; updated_at: string; error: string | null } | undefined;
    return row ? { status: row.status, config: JSON.parse(row.config_json) as Record<string, unknown>, installedAt: row.installed_at, updatedAt: row.updated_at, error: row.error ? connectorErrorMessage(row.error) : undefined } : undefined;
  }

  private recordInstallation(connector: ConnectorDescriptor, status: ConnectorInstallationStatus, config: Record<string, unknown> = {}, error?: string): void {
    const now = new Date().toISOString();
    this.db?.prepare('INSERT INTO control_connector_installations (tenant_id, connector_id, version, status, config_json, installed_at, updated_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, connector_id, version) DO UPDATE SET status=excluded.status,config_json=excluded.config_json,updated_at=excluded.updated_at,error=excluded.error').run(this.tenantId, connector.id, connector.version, status, JSON.stringify(config), now, now, error ? connectorErrorMessage(error) : null);
  }

  private credentialCount(connectorId: string): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM control_credentials WHERE tenant_id = ? AND connector_id = ?').get(this.tenantId, connectorId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private recordEvent(connectorId: string, eventType: string, status: string, message: string, metadata: Record<string, unknown> = {}): void {
    this.db?.prepare('INSERT INTO control_connector_events (tenant_id, connector_id, event_type, status, message, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(this.tenantId, connectorId, eventType, status, connectorErrorMessage(message), JSON.stringify(redactSensitiveValue(metadata)), new Date().toISOString());
  }
}

/** Connector 安装、凭据和运行时均以租户为边界惰性创建。 */
export class ConnectorControlPlaneRegistry {
  private controls = new Map<string, ConnectorControlPlane>();

  constructor(private db: DatabaseSync | undefined, private tools: ToolRegistry) {}

  forTenant(tenantId: string): ConnectorControlPlane {
    let control = this.controls.get(tenantId);
    if (!control) {
      control = new ConnectorControlPlane(this.db, this.tools, tenantId);
      this.controls.set(tenantId, control);
    }
    return control;
  }

  execute(connectorId: string, action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorExecutionResult> {
    return this.forTenant(context.tenantId).execute(connectorId, action, input, context);
  }

  reconcile(connectorId: string, action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<{ confirmed: boolean; output?: Record<string, unknown> }> {
    return this.forTenant(context.tenantId).reconcile(connectorId, action, input, context);
  }

  getCredential(id: string, tenantId: string): Record<string, import('@readywork/graph-runtime').JsonValue> | undefined {
    return this.forTenant(tenantId).getCredential(id);
  }
}
