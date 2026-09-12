import type { AgentDecisionHandler, AgentRuntimePort } from '@readywork/agent';
import { InMemoryAgentAdapter } from '@readywork/agent';
import { InMemoryContextStore } from '@readywork/context';
import { TowerService } from '@readywork/control-tower';
import type {
  AIEmployee,
  BusinessObject,
  EmployeeSpec,
  HumanEmployee,
  RuntimeHub,
  WorkerDef,
} from '@readywork/core';
import { createRuntimeHub, nowIso, emptyStats, uid } from '@readywork/core';
import type { SkillDef } from '@readywork/skills';
import { SkillRegistry } from '@readywork/skills';
import { createReferenceTools, ErpTool, ToolRegistry, type Mailer, type OdooPoBackend } from '@readywork/tools';
import type { WorkflowDef } from '@readywork/workflow';
import { WorkflowEngine } from '@readywork/workflow';

export { ProcurementOrchestrator, intentToPathInput } from './orchestrator.js';
export type { PurchasePathInput, PathDecision, PurchaseIntent, PurchasePathKind } from './orchestrator.js';
export {
  PROCUREMENT_NODE_ASSETS,
  PROCUREMENT_NODE_DESCRIPTORS,
  createProcurementNodeFactory,
  inferProcurementNodeDescriptor,
  procurementNodeAsset,
} from './node-catalog.js';
export type { ProcurementNodeAsset, ProcurementNodeKind } from './node-catalog.js';
export { PROCUREMENT_BUSINESS_NAVIGATION, PROCUREMENT_EMPLOYEE_PACK } from './procurement-employee-pack.js';
export { procurementNodeExecutorResolver } from './node-executors.js';
export type { ProcurementLineMatchInput, ProcurementNodeExecutorPorts } from './node-executors.js';
export { compareSupplierQuotes } from './quote-comparison.js';
export type {
  ExchangeRateSnapshot,
  NormalizedQuote,
  QuoteCharge,
  QuoteChargeKind,
  QuoteComparisonInput,
  QuoteComparisonResult,
  QuoteComparisonWeights,
  QuoteEligibility,
  QuoteInput,
  SupplierPerformance,
} from './quote-comparison.js';

/**
 * Supply Chain Workforce Pack —— 底层通用，产品垂直。
 * Pack 只做三件事：注册 Specs / 注册 Workflows / 注册行业 Skills 与 Agent 决策 Handler。
 */

export const TENANT_ID = 't:acme';
export const DEPT_PROCUREMENT = 'dept:procurement';
export const DEPT_SALES = 'dept:sales';
export const HUMAN_MANAGER = 'h:procurement-manager';
export const HUMAN_BUYER = 'h:buyer-1';
export const HUMAN_SALES_MANAGER = 'h:sales-manager';

// ---------------------------------------------------------------- ① 行业 Skills

export const SUPPLY_CHAIN_SKILLS: SkillDef[] = [
  {
    id: 'classify-requisition',
    name: '采购需求分类',
    description: '按关键词将需求描述分类为 原料/包材/设备/MRO',
    invoke: async (input) => {
      const d = String(input.description ?? '');
      const category = d.includes('设备') || d.includes('机器') ? '设备' : d.includes('原料') ? '原料' : d.includes('包') ? '包材' : 'MRO';
      return { category };
    },
  },
  {
    id: 'parse-delivery-date',
    name: '交期解析',
    description: '从文本中提取日期（YYYY-MM-DD / YYYY年M月D日 / YYYY/M/D）',
    invoke: async (input) => {
      const text = String(input.text ?? '');
      const m = text.match(/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})日?/);
      if (!m) return { ok: false, parsed: undefined };
      const parsed = `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
      return { ok: true, parsed };
    },
  },
  {
    id: 'detect-delay',
    name: '延期识别',
    description: '比较原承诺交期与新交期，计算延期天数',
    invoke: async (input) => {
      const baseline = String(input.baseline ?? '');
      const newDate = String(input.newDate ?? '');
      const b = Date.parse(baseline);
      const n = Date.parse(newDate);
      if (Number.isNaN(b) || Number.isNaN(n)) return { ok: false, delayed: false, days: 0, baseline, newDate };
      const days = Math.round((n - b) / 86_400_000);
      return { ok: true, delayed: days > 0, days, baseline, newDate };
    },
  },
  {
    id: 'parse-quote',
    name: '报价解析',
    description: '把报价邮件文本解析为结构化报价（供应商/品名/单价/交期）',
    invoke: async (input) => {
      const text = String(input.text ?? '');
      const re = /^([^\s:]+):?\s+(.+?)\s+单价\s*(\d+(?:\.\d+)?)\s*元.*?交期\s*(\d+)\s*天/;
      const quotes: { supplierId: string; item: string; unitPrice: number; deliveryDays: number }[] = [];
      for (const line of text.split('\n')) {
        const m = line.trim().match(re);
        if (m) quotes.push({ supplierId: m[1]!, item: m[2]!, unitPrice: Number(m[3]), deliveryDays: Number(m[4]) });
      }
      return { quotes };
    },
  },
  {
    id: 'compose-follow-up',
    name: '供应商沟通（催交）',
    description: '生成催交邮件正文',
    invoke: async (input) => {
      const poId = String(input.poId ?? '');
      const supplierName = String(input.supplierName ?? '供应商');
      const delayDays = Number(input.delayDays ?? 0);
      return {
        text: `尊敬的${supplierName}：\n\n关于订单 ${poId} 已延期 ${delayDays} 天，请尽快确认新的交期并加快生产进度，谢谢。\n\nAI 采购运营员工`,
      };
    },
  },
  {
    id: 'invoice-parse',
    name: '发票识别',
    description: '从发票文本提取供应商/金额/关联采购单号',
    invoke: async (input) => {
      const text = String(input.text ?? '');
      const po = text.match(/P\d{4,}/)?.[0] ?? '';
      const amount = Number(text.match(/(?:金额|￥|¥)\s*([0-9,.]+)/)?.[1]?.replace(/,/g, '') ?? 0);
      return { po, amount, text };
    },
  },
  {
    id: 'three-way-match',
    name: '三单匹配',
    description: '比较发票金额 vs 采购单金额 vs 收货数量，计算差异',
    invoke: async (input) => {
      const invoiceAmount = Number(input.invoiceAmount ?? 0);
      const poAmount = Number(input.poAmount ?? 0);
      const receiptQty = Number(input.receiptQty ?? 0);
      const poQty = Number(input.poQty ?? 0);
      const variance = poAmount > 0 ? Math.round(((invoiceAmount - poAmount) / poAmount) * 10000) / 100 : 0;
      const qtyOk = poQty > 0 ? receiptQty >= poQty : true;
      return { matched: Math.abs(variance) <= 1 && qtyOk, variance, qtyOk, invoiceAmount, poAmount, receiptQty, poQty };
    },
  },
];

// ---------------------------------------------------------------- ② Workers

export const SUPPLY_CHAIN_WORKERS: WorkerDef[] = [
  { id: 'requisition-classifier', name: '需求分类 Worker', description: '阅读需求描述并给出分类', capabilities: ['需求分析'], taskTypes: ['requisition'] },
  { id: 'rfq-collect', name: '报价收集 Worker', description: '汇总供应商报价邮件', capabilities: ['邮件收集'], taskTypes: ['rfq'] },
  { id: 'rfq-recommend', name: '比价推荐 Worker', description: '比较报价并推荐中标供应商', capabilities: ['比价'], taskTypes: ['rfq'] },
  { id: 'po-check', name: '订单核对 Worker', description: '核对订单与供应商确认状态', capabilities: ['订单核对'], taskTypes: ['po'] },
  { id: 'po-reply-parse', name: '回复解析 Worker', description: '提取供应商回复文本', capabilities: ['回复解析'], taskTypes: ['po'] },
  { id: 'eta-extractor', name: '交期提取 Worker', description: '从供应商回复中提取新交期日期（LLM 处理自然语言）', capabilities: ['交期提取'], taskTypes: ['po'] },
  { id: 'followup-worker', name: '催交 Worker', description: '生成并发送催交邮件', capabilities: ['催交沟通'], taskTypes: ['po'] },
  { id: 'invoice-parser', name: '发票识别 Worker', description: '识别发票的供应商/金额/关联采购单', capabilities: ['发票识别'], taskTypes: ['ap'] },
  { id: 'threeway-match', name: '三单匹配 Worker', description: '发票 vs 采购单 vs 收货单金额核对', capabilities: ['三单匹配'], taskTypes: ['ap'] },
  { id: 'procurement-intake', name: '采购事件识别 Worker', description: '识别供应商邮件/发票的意图（延期/拒单/发票/报价）并提取结构化字段', capabilities: ['意图识别'], taskTypes: ['requisition', 'po', 'invoice'] },
];

// ---------------------------------------------------------------- ③ Employee Specs

// Procurement Execution V1 只有一个 post-PO 执行员工，产品边界从 PO Sent 到最终 GRN。
// 询价、定标、发票与付款代码保留给后续独立 Employee Pack，不进入本员工的安装合同。
export const SUPPLY_CHAIN_SPECS: EmployeeSpec[] = [
  {
    id: 'spec:procurement',
    name: '采购执行员工',
    departmentId: DEPT_PROCUREMENT,
    version: '1.0.0',
    capabilityPackIds: ['capability:procurement'],
    role: '负责从 PO 发出、供应商确认、生产和交付跟踪，一直到最终收货 / GRN',
    description: '负责制造业采购订单发出后的供应商协同与交付执行；正常事项持续自动推进，异常交给人决定。',
    capabilities: [
      {
        id: 'cap-pack-po',
        name: 'PO 执行能力',
        description: 'PO 发出 · 供应商确认 · 生产跟踪 · 部分/全部发运 · 到货与最终 GRN · 风险预警 · ERP/WMS 回写',
        workflows: ['po-operations'],
        skills: ['parse-delivery-date', 'detect-delay', 'compose-follow-up'],
      },
    ],
    goals: [
      {
        id: 'g1',
        title: '保证采购订单按期交付',
        description: '从订单发出到到货全程跟踪，异常及时升级',
        kpis: [
          { id: 'k1', name: '准时交付率', unit: '%', target: 98 },
          { id: 'k2', name: '人工介入率', unit: '%', target: 5 },
        ],
      },
    ],
    workers: ['po-check', 'po-reply-parse', 'eta-extractor', 'followup-worker'],
    workflows: ['po-operations'],
    skills: ['parse-delivery-date', 'detect-delay', 'compose-follow-up'],
    tools: ['erp', 'email'],
    // V1 只授予 post-PO 执行动作；寻源、定标、应付和付款不属于本员工。
    permissions: [
      { effect: 'allow', action: 'po.get', resource: 'erp', note: '可查询 PO' },
      { effect: 'allow', action: 'po.update', resource: 'erp', note: '可在人工批准或规则授权后回写执行状态' },
      { effect: 'allow', action: 'po.close', resource: 'erp', note: '可在最终 GRN 证据完整后关闭 PO' },
      { effect: 'allow', action: 'send', resource: 'email', note: '可发送 PO 确认、催交和异常沟通' },
      { effect: 'deny', action: 'po.updatePrice', resource: 'erp', note: '不可修改采购价格' },
      { effect: 'deny', action: 'pay', resource: 'erp', note: '真正付款禁止（财务动作）' },
    ],
    policies: [
      { id: 'pol-price-lock', name: '价格锁定', when: (ctx) => ctx.action === 'po.updatePrice', then: 'block', message: '采购价格不可由 AI 员工修改' },
      { id: 'pol-pay-block', name: '付款禁止', when: (ctx) => ctx.action === 'pay', then: 'block', message: '真正付款禁止，仅可提交应付审核' },
    ],
    approvalRules: [
      { id: 'delay-over-7d', name: '延期超过 7 天审批', message: '供应商延期超过 7 天需人工审批', when: (ctx) => Number(ctx.payload?.days ?? 0) > 7, approver: 'manager' },
      { id: 'price-change', name: '价格变化审批', message: '采购价格变化需人工审批', when: (ctx) => ctx.action === 'po.updatePrice', approver: 'manager' },
    ],
    budget: { monthlyCap: 1000, currency: 'CNY' },
    contextScope: ['po', 'supplier', 'email', 'production_progress', 'shipment', 'receipt'],
    evalCriteria: [
      { id: 'e1', name: '准时交付率', formula: 'on_time_rate' },
      { id: 'e2', name: '人工介入率', formula: 'intervention_rate' },
    ],
    humanEscalation: { contactIds: [HUMAN_MANAGER, HUMAN_BUYER] },
  },
];

// ---------------------------------------------------------------- 销售侧（产品结构，真实业务闭环待采购 PO 闭环之后开发）

export const SALES_SKILLS: SkillDef[] = [
  { id: 'rfq-parse', name: '客户询价解析', description: '从邮件/PDF/Excel 提取技术参数（介质/温度/压力/口径）', invoke: async (i) => ({ text: String(i.text ?? '') }) },
  { id: 'product-match', name: '产品选型匹配', description: '把客户参数匹配到标准产品型号', invoke: async (i) => ({ matched: String(i.model ?? 'CV-420-316L'), confidence: 0.987 }) },
  { id: 'cost-calc', name: '核价与 BOM', description: '计算 BOM 成本', invoke: async () => ({ cost: 632 }) },
  { id: 'quote-generate', name: '报价单生成', description: '生成我方报价单', invoke: async (i) => ({ quoteId: 'Q-' + String(i.rfqId ?? '').replace('RFQ-', '') }) },
];

export const SALES_WORKERS: WorkerDef[] = [
  { id: 'rfq-parser', name: '客户询价解析 Worker', description: '识别客户与项目、提取技术参数', capabilities: ['询价解析'], taskTypes: ['quote'] },
  { id: 'product-matcher', name: '产品选型 Worker', description: '参数匹配产品、配置选型', capabilities: ['选型'], taskTypes: ['quote'] },
  { id: 'quote-estimator', name: '核价交期 Worker', description: 'BOM/成本/库存/产能 → 交期与定价', capabilities: ['核价'], taskTypes: ['quote'] },
];

export const SALES_SPECS: EmployeeSpec[] = [
  {
    id: 'spec:auto-quote',
    name: '报价与订单员工',
    departmentId: DEPT_SALES,
    version: '0.1.0',
    capabilityPackIds: ['capability:workforce-core'],
    role: '负责客户询价理解、产品选型、核价、交期计算、生成报价并在必要时人工审批（销售侧，第二员工）',
    goals: [
      {
        id: 'g1',
        title: '快速准确报价',
        description: '在承诺时效内给出准确、毛利达标的报价',
        kpis: [
          { id: 'k1', name: '报价响应及时率', unit: '%', target: 95 },
          { id: 'k2', name: '报价准确率', unit: '%', target: 98 },
          { id: 'k3', name: '毛利率达标率', unit: '%', target: 90 },
        ],
      },
    ],
    workers: ['rfq-parser', 'product-matcher', 'quote-estimator'],
    workflows: ['quote-process'],
    skills: ['rfq-parse', 'product-match', 'cost-calc', 'quote-generate'],
    tools: ['erp', 'email', 'pdf', 'excel'],
    permissions: [
      { effect: 'allow', action: 'read_customer_rfq', resource: '*' },
      { effect: 'allow', action: 'generate_quote_draft', resource: '*' },
      { effect: 'allow', action: 'send', resource: 'email', note: '可发报价单给客户' },
      { effect: 'deny', action: 'modify_floor_price', resource: '*', note: '不可修改底价' },
    ],
    policies: [],
    approvalRules: [
      { id: 'nonstd-quote', name: '非标产品报价审批', message: '非标配置需技术工程师审批', when: () => false, approver: 'tech-engineer' },
      { id: 'low-margin', name: '低毛利报价审批', message: '毛利率 < 25% 需销售经理审批', when: () => false, approver: 'manager' },
      { id: 'over-discount', name: '超权限折扣审批', message: '折扣 > 5% 需审批', when: () => false, approver: 'manager' },
    ],
    budget: { monthlyCap: 600, currency: 'CNY' },
    contextScope: ['customer', 'rfq', 'product', 'quote', 'order', 'email'],
    evalCriteria: [
      { id: 'e1', name: '报价响应及时率', formula: 'success_rate' },
      { id: 'e2', name: '人工介入率', formula: 'intervention_rate' },
    ],
    humanEscalation: { contactIds: [HUMAN_SALES_MANAGER] },
  },
];

// ---------------------------------------------------------------- ④ Workflows

export const SUPPLY_CHAIN_WORKFLOWS: WorkflowDef[] = [
  {
    id: 'requisition-confirm',
    name: '采购需求确认',
    description: '需求分类 → 大额审批（≥50万）→ ERP 建单 → 通知',
    trigger: '采购需求提交',
    steps: [
      { type: 'agent', worker: 'requisition-classifier', instruction: '阅读采购需求描述，给出需求分类结论' },
      {
        type: 'condition',
        if: (ctx) => Number(ctx.businessObject.attributes.amount ?? 0) >= 500_000,
        then: 2,
        else: 3,
      },
      {
        type: 'approval',
        ruleId: 'requisition-amount-over',
        title: '采购需求大额审批',
        message: '金额超过 50 万需人工审批',
        payload: (ctx) => ({
          requisitionId: ctx.businessObject.id,
          item: ctx.businessObject.attributes.item,
          amount: ctx.businessObject.attributes.amount,
        }),
      },
      {
        type: 'tool',
        tool: 'erp',
        action: 'requisition.create',
        args: {
          requisitionId: '{{bo.id}}',
          item: '{{bo.attributes.item}}',
          qty: '{{bo.attributes.qty}}',
          amount: '{{bo.attributes.amount}}',
        },
      },
      {
        type: 'notify',
        to: HUMAN_BUYER,
        message: (ctx) =>
          `采购需求 ${ctx.businessObject.id}（${String(ctx.workspace['classification'] ?? '')}）已确认并创建采购单`,
      },
      { type: 'end' },
    ],
  },
  {
    id: 'rfq-process',
    name: '询价流程',
    description: '创建询价单 → 邮件询价 → 等待报价 → 解析比价 → 中标审批 → 落单',
    trigger: '询价单创建',
    steps: [
      {
        type: 'tool',
        tool: 'erp',
        action: 'rfq.create',
        args: {
          rfqId: '{{bo.id}}',
          item: '{{bo.attributes.item}}',
          qty: '{{bo.attributes.qty}}',
          suppliers: '{{bo.attributes.suppliers}}',
        },
      },
      {
        type: 'tool',
        tool: 'email',
        action: 'send',
        args: {
          to: '{{bo.attributes.suppliers}}',
          subject: '询价邀请：{{bo.attributes.item}}',
          body: '请于 3 日内回复报价（格式：品名 单价 X 元 交期 N 天），规格见附件。',
        },
      },
      {
        type: 'wait',
        reason: '等待供应商报价',
        forEvent: { eventType: 'quote_received', objectId: '{{bo.id}}' },
        untilMs: 30_000,
      },
      { type: 'agent', worker: 'rfq-collect', instruction: '读取收到的供应商报价邮件，汇总为文本' },
      { type: 'skill', skill: 'parse-quote', input: { text: '{{workspace.email_replies}}' }, store: 'parsedQuotes' },
      { type: 'agent', worker: 'rfq-recommend', instruction: '比较各供应商报价，推荐中标供应商' },
      {
        type: 'approval',
        ruleId: 'rfq-award',
        title: '询价中标审批',
        message: '选定中标供应商需采购经理审批',
        payload: (ctx) => ({
          rfqId: ctx.businessObject.id,
          recommendedSupplier: ctx.workspace['recommendedSupplier'],
          quotes: ctx.workspace['parsedQuotes'],
        }),
      },
      {
        type: 'tool',
        tool: 'erp',
        action: 'rfq.award',
        args: { rfqId: '{{bo.id}}', supplierId: '{{workspace.recommendedSupplier}}' },
      },
      {
        type: 'notify',
        to: HUMAN_BUYER,
        message: (ctx) => `RFQ ${ctx.businessObject.id} 已中标：${String(ctx.workspace['recommendedSupplier'] ?? '')}`,
      },
      { type: 'end' },
    ],
  },
  {
    id: 'po-operations',
    name: '采购订单运营',
    description: '订单确认 → 等待供应商确认 → 延期检测 →（延期>7天 审批）→ 更新交期/催交 → 到货关闭',
    trigger: '采购订单发出',
    steps: [
      { type: 'tool', tool: 'erp', action: 'po.get', args: { poId: '{{bo.id}}' } },
      { type: 'skill', skill: 'parse-delivery-date', input: { text: '{{tool.erp.po.get.po.promiseDate}}' }, store: 'delivery' },
      { type: 'agent', worker: 'po-check', instruction: '核对订单信息与供应商确认状态' },
      {
        type: 'wait',
        reason: '等待供应商确认交期',
        forEvent: { eventType: 'supplier_confirmed', objectId: '{{bo.id}}' },
        untilMs: 30_000,
      },
      { type: 'agent', worker: 'po-reply-parse', instruction: '提取供应商最新回复文本' },
      { type: 'agent', worker: 'eta-extractor', instruction: '从供应商回复文本中提取新确认的交期日期，写入 stateUpdates.parsed（格式 YYYY-MM-DD，识别不到就置空）' },
      {
        type: 'skill',
        skill: 'detect-delay',
        input: {
          baseline: '{{tool.erp.po.get.po.promiseDate}}',
          newDate: '{{workspace.parsed}}',
        },
        store: 'delay',
      },
      {
        type: 'condition',
        if: (ctx) => {
          const d = ctx.workspace['delay'] as { delayed?: boolean; days?: number } | undefined;
          return Boolean(d?.delayed) && (d?.days ?? 0) > 7;
        },
        then: 8,
        else: 11,
      },
      {
        type: 'approval',
        ruleId: 'delay-over-7d',
        title: '延期超过 7 天审批',
        message: '供应商延期超过 7 天需人工审批',
        payload: (ctx) => {
          const d = ctx.workspace['delay'] as { days?: number; baseline?: string; newDate?: string };
          return {
            poId: ctx.businessObject.id,
            supplier: ctx.businessObject.attributes.supplierName,
            days: d?.days ?? 0,
            baseline: d?.baseline ?? ctx.businessObject.attributes.promiseDate,
            newDate: d?.newDate,
          };
        },
      },
      {
        type: 'tool',
        tool: 'erp',
        action: 'po.update',
        args: { poId: '{{bo.id}}', field: 'promiseDate', value: '{{workspace.parsed}}' },
      },
      { type: 'agent', worker: 'followup-worker', instruction: '处理延期：生成催交邮件并发送给供应商' },
      {
        type: 'wait',
        reason: '等待到货',
        forEvent: { eventType: 'goods_received', objectId: '{{bo.id}}' },
        untilMs: 30_000,
      },
      { type: 'tool', tool: 'erp', action: 'po.close', args: { poId: '{{bo.id}}' } },
      {
        type: 'tool',
        tool: 'excel',
        action: 'appendRow',
        args: {
          sheet: 'PO台账',
          row: ['{{bo.id}}', '{{bo.attributes.supplierName}}', '{{workspace.parsed}}', 'closed'],
        },
      },
      {
        type: 'notify',
        to: HUMAN_MANAGER,
        message: (ctx) => `PO ${ctx.businessObject.id} 已到货并关闭`,
      },
      { type: 'end' },
    ],
  },
  {
    id: 'quote-process',
    name: '客户报价流程',
    description: '客户询价解析 → 产品选型 → 核价交期 → 低毛利审批 → 生成报价单 → 邮件发送',
    trigger: '客户询价',
    steps: [
      { type: 'agent', worker: 'rfq-parser', instruction: '识别客户与项目，提取技术参数（介质/温度/压力/口径）' },
      { type: 'skill', skill: 'rfq-parse', input: { text: '{{workspace.rfqText}}' }, store: 'parsedRfq' },
      { type: 'agent', worker: 'product-matcher', instruction: '根据技术参数匹配标准产品型号' },
      { type: 'skill', skill: 'product-match', input: { model: '{{workspace.model}}' }, store: 'matched' },
      { type: 'agent', worker: 'quote-estimator', instruction: '计算 BOM 成本、交期与定价' },
      { type: 'skill', skill: 'cost-calc', input: {}, store: 'cost' },
      {
        type: 'condition',
        if: (ctx) => Number(ctx.workspace['margin'] ?? 1) < 0.25,
        then: 7,
        else: 8,
      },
      {
        type: 'approval',
        ruleId: 'low-margin',
        title: '低毛利报价审批',
        message: '毛利率 < 25% 需销售经理审批',
        payload: (ctx) => ({
          quoteId: ctx.businessObject.id,
          model: ctx.workspace['model'],
          cost: ctx.workspace['cost'],
          price: ctx.workspace['price'],
          margin: ctx.workspace['margin'],
        }),
      },
      { type: 'skill', skill: 'quote-generate', input: { rfqId: '{{bo.id}}' }, store: 'quote' },
      {
        type: 'tool',
        tool: 'email',
        action: 'send',
        args: {
          to: '{{bo.attributes.customerEmail}}',
          subject: '报价单 {{bo.id}}',
          body: '报价单号 {{skill.quote.quoteId}}，型号 {{workspace.matched.matched}}，单价 ¥{{workspace.price}}，交期 {{workspace.deliveryDays}} 天。',
        },
      },
      { type: 'notify', to: HUMAN_SALES_MANAGER, message: (ctx) => `客户询价 ${ctx.businessObject.id} 已生成报价 ${String((ctx.workspace['quote'] as { quoteId?: string } | undefined)?.quoteId ?? '')}` },
      { type: 'end' },
    ],
  },
  {
    id: 'invoice-match',
    name: '应付核对流程',
    description: '发票识别 → 关联采购单/收货单 → 三单匹配 → 差异审批 → 台账登记 → 通知',
    trigger: '供应商发票',
    steps: [
      { type: 'agent', worker: 'invoice-parser', instruction: '识别发票：提取关联采购单号与金额' },
      { type: 'tool', tool: 'erp', action: 'po.get', args: { poId: '{{workspace.invoicePo}}' } },
      {
        type: 'skill',
        skill: 'three-way-match',
        input: {
          invoiceAmount: '{{workspace.invoiceAmount}}',
          poAmount: '{{tool.erp.po.get.po.amountTotal}}',
          receiptQty: '{{bo.attributes.receiptQty}}',
          poQty: '{{bo.attributes.qty}}',
        },
        store: 'match',
      },
      {
        type: 'condition',
        if: (ctx) => Number((ctx.workspace['match'] as { variance?: number } | undefined)?.variance ?? 0) > 1,
        then: 4,
        else: 5,
      },
      {
        type: 'approval',
        ruleId: 'variance-over',
        title: '三单匹配差异审批',
        message: '发票金额与采购单差异超过 1% 需审批',
        payload: (ctx) => {
          const m = ctx.workspace['match'] as { variance?: number; invoiceAmount?: number; poAmount?: number } | undefined;
          return { invoiceId: ctx.businessObject.id, po: ctx.workspace['invoicePo'], variance: m?.variance ?? 0, invoiceAmount: m?.invoiceAmount, poAmount: m?.poAmount };
        },
      },
      {
        type: 'tool',
        tool: 'excel',
        action: 'appendRow',
        args: {
          sheet: '应付台账',
          row: ['{{bo.id}}', '{{workspace.invoicePo}}', '{{workspace.invoiceAmount}}', '{{workspace.match.variance}}'],
        },
      },
      { type: 'notify', to: HUMAN_MANAGER, message: (ctx) => `发票 ${ctx.businessObject.id} 已核对（差异 ${String((ctx.workspace['match'] as { variance?: number } | undefined)?.variance ?? 0)}%）` },
      { type: 'end' },
    ],
  },
];

// ---------------------------------------------------------------- ⑤ Agent 决策 Handlers

export const SUPPLY_CHAIN_HANDLERS: Record<string, AgentDecisionHandler> = {
  'requisition-classifier': (req) => {
    const entity = req.contextSnapshot.entities.find((e) => e.type === 'requisition');
    const description = String(entity?.attributes.description ?? '');
    const category = description.includes('设备') || description.includes('机器') ? '设备' : description.includes('原料') ? '原料' : description.includes('包') ? '包材' : 'MRO';
    return {
      reasoning: `需求「${description.slice(0, 24)}${description.length > 24 ? '…' : ''}」→ 分类：${category}`,
      actions: [],
      stateUpdates: { classification: category },
    };
  },
  'rfq-collect': (req) => {
    const emails = req.contextSnapshot.entities.filter((e) => e.type === 'email');
    const bodies = emails.map((e) => `${String(e.attributes.from ?? '')}: ${String(e.attributes.body ?? '')}`).join('\n');
    return {
      reasoning: `收集到 ${emails.length} 封供应商报价邮件`,
      actions: [],
      stateUpdates: { email_replies: bodies },
    };
  },
  'rfq-recommend': (req) => {
    const parsed = req.workspace['parsedQuotes'] as { quotes?: { supplierId: string; unitPrice: number; deliveryDays: number }[] } | undefined;
    const quotes = parsed?.quotes ?? [];
    if (quotes.length === 0) {
      return { reasoning: '没有可比较的报价', actions: [], stateUpdates: { recommendedSupplier: '' } };
    }
    const best = [...quotes].sort((a, b) => a.unitPrice - b.unitPrice)[0]!;
    return {
      reasoning: `比较 ${quotes.length} 家报价（最低 ${best.unitPrice} 元/${best.deliveryDays}天）→ 推荐 ${best.supplierId}`,
      actions: [],
      stateUpdates: { recommendedSupplier: best.supplierId },
    };
  },
  'po-check': (req) => {
    const emails = req.contextSnapshot.entities.filter((e) => e.type === 'email');
    const latest = emails[emails.length - 1];
    return {
      reasoning: latest ? `已收到供应商邮件「${String(latest.attributes.subject ?? '')}」` : '尚未收到供应商回复',
      actions: [],
      stateUpdates: { replyReceived: Boolean(latest), latestReplySubject: latest?.attributes.subject },
    };
  },
  'po-reply-parse': (req) => {
    const emails = req.contextSnapshot.entities.filter((e) => e.type === 'email');
    const latest = emails[emails.length - 1];
    return {
      reasoning: '提取最新供应商邮件正文用于交期解析',
      actions: [],
      stateUpdates: { replyText: String(latest?.attributes.body ?? '') },
    };
  },
  'eta-extractor': (req) => {
    // 确定性桩：正则提取日期；真模型下由 DeepSeek 从自然语言邮件中提取
    const text = String(req.workspace['replyText'] ?? '');
    const m = text.match(/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})日?/);
    const parsed = m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : '';
    return {
      reasoning: parsed ? `从供应商回复提取新交期 ${parsed}` : '未在回复中识别到明确日期',
      actions: [],
      stateUpdates: { parsed },
    };
  },
  'followup-worker': (req) => {
    const delay = req.workspace['delay'] as { days?: number } | undefined;
    const supplier = req.contextSnapshot.entities.find((e) => e.type === 'supplier');
    const poData = req.workspace['tool.erp.po.get'] as { po?: { id?: string } } | undefined;
    const poId = poData?.po?.id ?? req.taskId;
    return {
      reasoning: `延期 ${delay?.days ?? 0} 天 → 生成催交邮件并发送给 ${String(supplier?.attributes.name ?? '供应商')}`,
      actions: [
        {
          type: 'skill',
          skill: 'compose-follow-up',
          input: {
            poId,
            supplierName: supplier?.attributes.name ?? '供应商',
            delayDays: delay?.days ?? 0,
          },
        },
        {
          type: 'tool',
          tool: 'email',
          action: 'send',
          args: {
            to: String(supplier?.attributes.email ?? ''),
            subject: `PO-${poId} 延期跟进`,
            body: '{{skill.compose-follow-up.text}}',
          },
        },
      ],
      stateUpdates: { followUpSent: true },
    };
  },
  // —— 销售侧（报价与订单员工）——
  'rfq-parser': (req) => {
    const email = req.contextSnapshot.entities.find((e) => e.type === 'email');
    const body = String(email?.attributes.body ?? '');
    const medium = body.match(/介质[：:]\s*([^，,；;\n]+)/)?.[1] ?? '水';
    const temp = body.match(/温度[：:]\s*([^，,；;\n]+)/)?.[1] ?? '常温';
    const pressure = body.match(/压力[：:]\s*([^，,；;\n]+)/)?.[1] ?? '0.6MPa';
    const calibre = body.match(/口径[：:]\s*([^，,；;\n]+)/)?.[1] ?? 'DN50';
    return {
      reasoning: `解析客户询价：介质=${medium} 温度=${temp} 压力=${pressure} 口径=${calibre} → 候选型号 CV-420-316L`,
      actions: [],
      stateUpdates: { rfqText: body, medium, temp, pressure, calibre, model: 'CV-420-316L' },
    };
  },
  'product-matcher': (req) => {
    const model = String(req.workspace['model'] ?? 'CV-420-316L');
    return {
      reasoning: `技术参数匹配标准产品 → ${model}`,
      actions: [],
      stateUpdates: { matchedModel: model, confidence: 0.98 },
    };
  },
  'quote-estimator': (req) => {
    const cost = 632;
    const price = 780;
    const deliveryDays = 12;
    const margin = Math.round(((price - cost) / price) * 1000) / 1000;
    return {
      reasoning: `BOM 成本 ¥${cost} → 报价 ¥${price}（毛利率 ${(margin * 100).toFixed(1)}%，低于 25% 需审批）交期 ${deliveryDays} 天`,
      actions: [],
      stateUpdates: { cost, price, deliveryDays, margin },
    };
  },
  // —— 应付核对员工 ——
  'invoice-parser': (req) => {
    const inv = req.contextSnapshot.entities.find((e) => e.type === 'invoice');
    const poNumber = String(inv?.attributes.poNumber ?? '');
    const amount = Number(inv?.attributes.amount ?? 0);
    return {
      reasoning: `识别发票（关联采购单 ${poNumber}，金额 ¥${amount}）`,
      actions: [],
      stateUpdates: { invoicePo: poNumber, invoiceAmount: amount, invoiceText: String(inv?.attributes.text ?? '') },
    };
  },
  'threeway-match': (req) => {
    const match = req.workspace['match'] as { matched?: boolean; variance?: number } | undefined;
    const variance = match?.variance ?? 0;
    return {
      reasoning: match?.matched ? `三单匹配通过（差异 ${variance}%）` : `三单匹配差异 ${variance}%，需审批`,
      actions: [],
      stateUpdates: { matched: Boolean(match?.matched), variance },
    };
  },
  // —— 采购事件识别（确定性桩；真模型下由 DeepSeek 做自然语言意图识别）——
  'procurement-intake': (req) => {
    const email = req.contextSnapshot.entities.find((e) => e.type === 'email');
    const text = `${String(email?.attributes.subject ?? '')}\n${String(email?.attributes.body ?? '')}`;
    let intent: string = 'other';
    if (/拒单|无法接单|没有产能|无法供应|取消订单/i.test(text)) intent = 'supplier_reject';
    else if (/发票|开票|invoice/i.test(text)) intent = 'invoice';
    else if (/新交期|延期|交期确认为|交货日期|晚.*天/i.test(text)) intent = 'delay';
    else if (/报价|单价|询价/i.test(text)) intent = 'rfq_quote';
    const poNumber = text.match(/P\d{4,}/)?.[0] ?? '';
    const newEta = text.match(/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})日?/)?.[0] ?? '';
    return {
      reasoning: `识别采购事件意图：${intent}${poNumber ? '（' + poNumber + '）' : ''}`,
      actions: [],
      stateUpdates: { intent, poNumber, newEta, text },
    };
  },
};

// ---------------------------------------------------------------- ⑥ 运行时装配

export interface SupplyChainRuntime {
  hub: RuntimeHub;
  engine: WorkflowEngine;
  agent: AgentRuntimePort;
  skills: SkillRegistry;
  tools: ToolRegistry;
  context: InMemoryContextStore;
  tower: TowerService;
  employees: { procurement: AIEmployee; quote: AIEmployee };
  humans: { manager: HumanEmployee; buyer: HumanEmployee };
}

export interface SupplyChainRuntimeOptions {
  logger?: (line: string) => void;
  /** 外部 Agent 实现（如 DeepSeekHarnessAdapter）；缺省用 InMemoryAgentAdapter 确定性桩 */
  agent?: AgentRuntimePort;
  /** 外部 RuntimeHub（如持久化仓储版本）；缺省创建内存版 */
  hub?: RuntimeHub;
  /** 真实邮件发送器（如网易 SMTP 连接器）；缺省时 EmailTool 只入内存发件箱 */
  mailer?: Mailer;
  /** 真实 ERP 后端（如 OdooErpClient）；配置后 po.get/po.update 真实读写 Odoo */
  odoo?: OdooPoBackend;
}

export function createSupplyChainRuntime(opts: SupplyChainRuntimeOptions = {}): SupplyChainRuntime {
  const hub = opts.hub ?? createRuntimeHub();

  // 组织
  hub.org.registerTenant({ id: TENANT_ID, name: '苏州精工制造有限公司' });
  hub.org.registerDepartment({ id: DEPT_PROCUREMENT, tenantId: TENANT_ID, name: '采购部' });
  const manager = hub.org.registerHuman({
    id: HUMAN_MANAGER,
    tenantId: TENANT_ID,
    deptId: DEPT_PROCUREMENT,
    name: '王经理',
    email: 'manager@jinggong.cn',
    role: '采购经理',
  });
  const buyer = hub.org.registerHuman({
    id: HUMAN_BUYER,
    tenantId: TENANT_ID,
    deptId: DEPT_PROCUREMENT,
    name: '李采购',
    email: 'li@jinggong.cn',
    role: '采购专员',
  });
  hub.org.registerDepartment({ id: DEPT_SALES, tenantId: TENANT_ID, name: '销售部' });
  hub.org.registerHuman({
    id: HUMAN_SALES_MANAGER,
    tenantId: TENANT_ID,
    deptId: DEPT_SALES,
    name: '陈经理',
    email: 'chen@jinggong.cn',
    role: '销售经理',
  });

  // 能力层
  const context = new InMemoryContextStore();
  const skills = new SkillRegistry();
  for (const s of SUPPLY_CHAIN_SKILLS) skills.register(s);
  for (const s of SALES_SKILLS) skills.register(s);
  const tools = new ToolRegistry();
  for (const t of createReferenceTools(opts.mailer, opts.odoo)) tools.register(t);

  // Agent 层（默认 InMemory 确定性桩；可注入 DeepSeekHarnessAdapter 等外部实现）
  const agent = opts.agent ?? new InMemoryAgentAdapter({ logger: opts.logger });
  if (opts.agent === undefined) {
    for (const [id, h] of Object.entries(SUPPLY_CHAIN_HANDLERS)) (agent as InMemoryAgentAdapter).register(id, h);
  }

  // 流程层
  const engine = new WorkflowEngine({ hub, agent, skills, tools, context });
  for (const w of SUPPLY_CHAIN_WORKFLOWS) engine.register(w);

  // 控制塔
  const tower = new TowerService(hub, engine);

  // 员工 Specs 与 Workers
  for (const s of SUPPLY_CHAIN_SPECS) hub.specs.register(s);
  for (const w of SUPPLY_CHAIN_WORKERS) hub.workers.register(w);
  for (const s of SALES_SPECS) hub.specs.register(s);
  for (const w of SALES_WORKERS) hub.workers.register(w);

  // AI 员工实例化（Employee Definition → AIEmployee）
  // V1 采购侧只有一个 post-PO 执行员工；询价和应付由后续 Employee Pack 承担。
  const procurement = hub.org.registerAI({
    id: 'ai:procurement',
    tenantId: TENANT_ID,
    deptId: DEPT_PROCUREMENT,
    specId: 'spec:procurement',
    name: '采购执行员工',
    role: 'PO 发出 · 供应商确认 · 生产跟踪 · 交付追踪 · 最终 GRN',
    status: 'idle',
    managerId: HUMAN_MANAGER,
    stats: emptyStats(),
    createdAt: nowIso(),
  });
  const quote = hub.org.registerAI({
    id: 'ai:auto-quote',
    tenantId: TENANT_ID,
    deptId: DEPT_SALES,
    specId: 'spec:auto-quote',
    name: '报价与订单员工',
    role: '客户自动报价（销售侧）',
    status: 'idle',
    managerId: HUMAN_SALES_MANAGER,
    stats: emptyStats(),
    createdAt: nowIso(),
  });

  return { hub, engine, agent, skills, tools, context, tower, employees: { procurement, quote }, humans: { manager, buyer } };
}

// ---------------------------------------------------------------- ⑦ 演示辅助（业务事件注入）

/** 把业务对象同步为 Context 实体（含与供应商的关系） */
export function syncObjectToContext(rt: SupplyChainRuntime, bo: BusinessObject): void {
  rt.context.upsertEntity({ id: bo.id, type: bo.type, attributes: bo.attributes, state: bo.state });
  const supplierId = String(bo.attributes.supplierId ?? '');
  if (supplierId) rt.context.relate(bo.id, supplierId, 'purchased_from');
}

export function seedSupplier(rt: SupplyChainRuntime, input: { id: string; name: string; email: string }): void {
  rt.context.upsertEntity({ id: input.id, type: 'supplier', attributes: { name: input.name, email: input.email } });
}

/** 注入一封"供应商来信"，并触发对应业务事件（恢复等待中的任务） */
export function seedSupplierEmail(
  rt: SupplyChainRuntime,
  input: { from: string; subject: string; body: string; eventType: string; objectId: string },
): void {
  rt.context.upsertEntity({
    id: uid('email'),
    type: 'email',
    attributes: { from: input.from, subject: input.subject, body: input.body },
  });
  rt.context.recordEvidence({ entityId: input.objectId, source: `email:${input.from}`, summary: input.subject });
  rt.hub.bus.emit({
    type: 'context.event',
    eventType: input.eventType,
    objectId: input.objectId,
    payload: { from: input.from },
    at: nowIso(),
  });
}

export function seedGoodsReceived(rt: SupplyChainRuntime, poId: string): void {
  rt.context.recordEvidence({ entityId: poId, source: 'wms', summary: '货物已签收' });
  rt.hub.bus.emit({ type: 'context.event', eventType: 'goods_received', objectId: poId, at: nowIso() });
}

export function erpOf(rt: SupplyChainRuntime): ErpTool {
  const erp = rt.tools.get('erp');
  if (!(erp instanceof ErpTool)) throw new Error('erp 工具不可用');
  return erp;
}
