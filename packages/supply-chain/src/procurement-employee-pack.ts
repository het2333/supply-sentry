import { validateEmployeePackManifest, type EmployeePackManifest } from '@readywork/core';

/**
 * Readywork Procurement Execution owns post-PO execution only. Sourcing and
 * AP building blocks remain in the repository for later Employee Packs, but
 * they must not leak into this installable contract or developer catalogue.
 */
const PROCUREMENT_EXECUTION_NODE_TYPE_IDS = [
  'trigger.erp_event',
  'trigger.email_received',
  'trigger.schedule',
  'trigger.manual',
  'ai.po_check',
  'ai.supplier_reply_parse',
  'ai.delivery_date_extract',
  'ai.followup_compose',
  'logic.condition',
  'logic.wait_event',
  'human.approval',
  'logic.parallel',
  'business.action',
  'connector.email.send_supplier_email',
  'connector.erp.action',
  'connector.wms.action',
] as const;

export const PROCUREMENT_BUSINESS_NAVIGATION = [
  { id: 'home', label: '总览', icon: 'layout-dashboard' },
  { id: 'notifications', label: '通知', icon: 'bell' },
  { id: 'message-drafts', label: '邮件草稿', icon: 'mail' },
  { id: 'local-procurement', label: '本地采购', icon: 'shopping-cart' },
  { id: 'import-procurement', label: '进口采购', icon: 'globe-2' },
  { id: 'risk-dashboard', label: '风险看板', icon: 'activity' },
  { id: 'suppliers', label: '供应商', icon: 'users-round' },
  { id: 'sla', label: '服务等级', icon: 'clock-3' },
  { id: 'advanced-sla', label: '高级服务等级', icon: 'shield-check' },
  { id: 'settings', label: '自动跟单', icon: 'settings' },
] as const;

/**
 * Readywork Procurement Execution 的可安装产品合同。
 * 这里只声明真实代码中已经存在的资产；业务记录、租户配置与凭据不进入 Pack。
 */
export const PROCUREMENT_EMPLOYEE_PACK: EmployeePackManifest = validateEmployeePackManifest({
  id: 'capability:procurement',
  version: '1.0.0',
  name: 'Readywork 采购执行',
  description: '制造业 PO 执行 Employee Pack：从 PO 发出、供应商确认、生产与发运跟踪，一直到最终收货 / GRN。',
  defaultEmployeeId: 'ai:procurement',
  branding: {
    productName: 'READYWORK',
    employeeSubtitle: '采购执行员工',
    workspaceLabel: '采购工作台',
    themeId: 'readywork-procurement',
  },
  assets: {
    employeeSpecIds: ['spec:procurement'],
    workerIds: ['po-check', 'po-reply-parse', 'eta-extractor', 'followup-worker'],
    workflowIds: ['po-operations', 'supplier-followup', 'delivery-receipt'],
    skillIds: ['parse-delivery-date', 'detect-delay', 'compose-follow-up'],
    toolIds: ['erp', 'email'],
    nodeTypeIds: [...PROCUREMENT_EXECUTION_NODE_TYPE_IDS],
  },
  interfaces: {
    business: {
      id: 'business',
      label: '采购业务视图',
      enabled: true,
      defaultSectionId: 'home',
      ownedSectionIds: [
        'home', 'notifications', 'message-drafts', 'po-intake', 'local-procurement',
        'import-procurement', 'risk-dashboard', 'orders', 'suppliers', 'sla', 'advanced-sla',
        'settings',
      ],
      navigationGroups: [{ id: 'procurement', label: '', items: [...PROCUREMENT_BUSINESS_NAVIGATION] }],
    },
    developer: {
      id: 'developer',
      label: '采购流程编排',
      enabled: true,
      defaultSectionId: 'employees',
      ownedSectionIds: ['employees'],
      navigationGroups: [],
    },
  },
  lifecycle: {
    entityType: 'purchase_order',
    startStageId: 'po-sent',
    terminalStageId: 'grn',
    stages: [
      {
        id: 'po-sent',
        label: 'PO 已发送',
        description: '采购订单已通过真实邮件或 ERP 通道发给供应商，等待可追溯回执。',
        workflowIds: ['po-operations'],
      },
      {
        id: 'supplier-commitment',
        label: '供应商承诺',
        description: '解析供应商对数量、价格和交期的承诺；差异超过权限时交给人审批。',
        workflowIds: ['po-operations', 'supplier-followup'],
      },
      {
        id: 'production',
        label: '生产',
        description: '持续跟踪生产进度、承诺偏差和催交结果，只在风险或超时出现时升级。',
        workflowIds: ['po-operations', 'supplier-followup'],
      },
      {
        id: 'dispatch-transit',
        label: '发运 / 运输',
        description: '登记部分或全部发运、运输节点与预计到货，并保留外部证据。',
        workflowIds: ['po-operations', 'delivery-receipt'],
      },
      {
        id: 'grn',
        label: 'GRN',
        description: '累计部分收货，最终以 Odoo 或 WMS 的真实 GRN 证据完成执行闭环。',
        workflowIds: ['delivery-receipt'],
      },
    ],
  },
  context: { entityTypes: ['po', 'supplier', 'email', 'production_progress', 'shipment', 'receipt'] },
  governance: {
    policyIds: ['pol-price-lock', 'pol-pay-block'],
    approvalRuleIds: ['delay-over-7d', 'price-change'],
    evalCriterionIds: ['e1', 'e2'],
  },
  connectors: [
    { connectorId: 'erp', required: false, actionIds: ['po.get', 'po.update'] },
    { connectorId: 'email', required: true, actionIds: ['send', 'inbox.list'] },
    { connectorId: 'wms', required: false, actionIds: ['execute'] },
    { connectorId: 'whatsapp', required: false, actionIds: ['send_template'] },
  ],
});
