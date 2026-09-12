import { z } from 'zod';

/**
 * Canonical Advanced SLA rule contract shared by the business API and console.
 * The parameter discriminator is deliberately persisted so a rule cannot be
 * interpreted as a different domain after JSON/CSV normalization.
 */
export const ADVANCED_SLA_DOMAINS = [
  'production_service_milestones',
  'communication_escalation',
  'payment_terms',
  'logistics_planning',
  'logistics_handover',
  'transit_monitoring',
  'regulatory_import_approval',
  'customs_clearance',
  'quality_inspection_grn',
] as const;

export const ADVANCED_SLA_STAGES = ['po_sent', 'supplier_commitment', 'fulfilment_production', 'dispatch_transit', 'delivery_grn'] as const;
export const ADVANCED_SLA_ROUTES = ['all', 'local', 'import', 'unclassified'] as const;
export const ADVANCED_SLA_RISKS = ['all', 'high', 'medium', 'low'] as const;
export const ADVANCED_SLA_CHANNELS = ['email', 'whatsapp'] as const;

export type AdvancedSlaDomain = typeof ADVANCED_SLA_DOMAINS[number];
export type AdvancedSlaStage = typeof ADVANCED_SLA_STAGES[number];
export type AdvancedSlaRoute = typeof ADVANCED_SLA_ROUTES[number];
export type AdvancedSlaRisk = typeof ADVANCED_SLA_RISKS[number];
export type AdvancedSlaChannel = typeof ADVANCED_SLA_CHANNELS[number];

export interface AdvancedSlaRuleScope {
  stage: AdvancedSlaStage;
  route: AdvancedSlaRoute;
  risk: AdvancedSlaRisk;
  channel: AdvancedSlaChannel;
}

export interface ProductionServiceMilestoneParameters {
  domain: 'production_service_milestones';
  supplierScope: string;
  itemOrService: string;
  milestoneSequence: number;
  blockingRuleIds: string[];
  standardDurationHours: number;
  updateCadenceHours: number;
  startEvidence: string;
  completionEvidence: string;
  supplierContactRole: string;
}

export interface CommunicationEscalationParameters {
  domain: 'communication_escalation';
  eventType: string;
  firstResponseHours: number;
  firstReminderHours: number;
  secondReminderHours: number;
  managerEscalationHours: number;
  escalationChannels: AdvancedSlaChannel[];
  supplierLevel1Role: string;
  supplierLevel2Role: string;
  supplierLevel3Role: string;
  firstReminderRisk: Exclude<AdvancedSlaRisk, 'all'>;
  secondReminderRisk: Exclude<AdvancedSlaRisk, 'all'>;
  managerEscalationRisk: Exclude<AdvancedSlaRisk, 'all'>;
}

export interface PaymentTermParameters {
  domain: 'payment_terms';
  paymentTerm: string;
  triggerEvent: string;
  preparationHours: number;
  completionSlaHours: number;
  blockingStage: AdvancedSlaStage;
  requiredDocuments: string[];
  responsibleFunction: string;
  lcRequired: boolean;
  lcDetails: string | null;
}

export interface LogisticsPlanningParameters {
  domain: 'logistics_planning';
  planningActivity: string;
  bookingLeadTimeHours: number;
  capacityRequirement: string;
  planningEvidence: string;
  responsibleFunction: string;
}

export interface LogisticsHandoverParameters {
  domain: 'logistics_handover';
  handoverRequirement: string;
  requiredEvidence: string[];
  documentTemplates: string[];
  handoverSlaHours: number;
  responsibleFunction: string;
}

export interface TransitMonitoringParameters {
  domain: 'transit_monitoring';
  transitMilestone: string;
  updateCadenceHours: number;
  exceptionTemplate: string;
  escalationTemplate: string;
  trackingEvidence: string;
  responsibleFunction: string;
}

export interface RegulatoryImportApprovalParameters {
  domain: 'regulatory_import_approval';
  approvalName: string;
  authority: string;
  dependencyRuleIds: string[];
  preparationHours: number;
  approvalSlaHours: number;
  requiredDocuments: string[];
  approvalEvidence: string;
  responsibleFunction: string;
}

export interface CustomsClearanceParameters {
  domain: 'customs_clearance';
  clearanceMilestone: string;
  requiredDocuments: string[];
  blockingRuleIds: string[];
  clearanceSlaHours: number;
  escalationTemplate: string;
  clearanceEvidence: string;
  responsibleFunction: string;
}

export interface QualityInspectionGrnParameters {
  domain: 'quality_inspection_grn';
  inspectionType: string;
  inspectionSlaHours: number;
  grnSlaHours: number;
  requiredEvidence: string[];
  qualityOwnerRole: string;
  grnOwnerRole: string;
  rejectionEscalationRole: string;
  acceptanceCriteria: string;
}

export type AdvancedSlaRuleParameters =
  | ProductionServiceMilestoneParameters
  | CommunicationEscalationParameters
  | PaymentTermParameters
  | LogisticsPlanningParameters
  | LogisticsHandoverParameters
  | TransitMonitoringParameters
  | RegulatoryImportApprovalParameters
  | CustomsClearanceParameters
  | QualityInspectionGrnParameters;

export interface AdvancedSlaRule {
  id: string;
  name: string;
  enabled: boolean;
  scope: AdvancedSlaRuleScope;
  parameters: AdvancedSlaRuleParameters;
}

export interface AdvancedSlaSection {
  domain: AdvancedSlaDomain;
  enabled: boolean;
  rules: AdvancedSlaRule[];
}

export interface AdvancedSlaAutoSend {
  enabled: boolean;
  stages: AdvancedSlaStage[];
  channels: AdvancedSlaChannel[];
  risks: AdvancedSlaRisk[];
}

export type AdvancedSlaParameterFieldKind = 'text' | 'textarea' | 'number' | 'string_list' | 'channel_list' | 'risk' | 'stage' | 'boolean' | 'nullable_text' | 'select' | 'date';
export interface AdvancedSlaParameterFieldDefinition {
  key: string;
  label: string;
  kind: AdvancedSlaParameterFieldKind;
  min?: number;
  max?: number;
  required?: boolean;
  placeholder?: string;
  section?: string;
  options?: readonly { value: string; label: string }[];
  showWhen?: { key: string; equals: string };
}

/** Public-contract field families and their editor labels/bounds. */
export const ADVANCED_SLA_PARAMETER_FIELDS: Record<AdvancedSlaDomain, readonly AdvancedSlaParameterFieldDefinition[]> = {
  production_service_milestones: [
    { key: 'supplierScope', label: '供应商范围', kind: 'text' },
    { key: 'itemOrService', label: '物料 / 服务', kind: 'text' },
    { key: 'milestoneSequence', label: '里程碑序号', kind: 'number', min: 1, max: 1000 },
    { key: 'blockingRuleIds', label: '阻塞依赖规则 ID', kind: 'string_list' },
    { key: 'standardDurationHours', label: '标准时长（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'updateCadenceHours', label: '更新频率（小时）', kind: 'number', min: 1, max: 8760 },
    { key: 'startEvidence', label: '开始证据', kind: 'text' },
    { key: 'completionEvidence', label: '完成证据', kind: 'text' },
    { key: 'supplierContactRole', label: '供应商联系人角色', kind: 'text' },
  ],
  communication_escalation: [
    { key: 'eventType', label: '事件类型', kind: 'text' },
    { key: 'firstResponseHours', label: '首次响应 SLA（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'firstReminderHours', label: '第一次提醒（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'secondReminderHours', label: '第二次提醒（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'managerEscalationHours', label: '经理升级（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'escalationChannels', label: '升级渠道', kind: 'channel_list' },
    { key: 'supplierLevel1Role', label: '供应商 L1 角色', kind: 'text' },
    { key: 'supplierLevel2Role', label: '供应商 L2 角色', kind: 'text' },
    { key: 'supplierLevel3Role', label: '供应商 L3 角色', kind: 'text' },
    { key: 'firstReminderRisk', label: '第一次提醒风险', kind: 'risk' },
    { key: 'secondReminderRisk', label: '第二次提醒风险', kind: 'risk' },
    { key: 'managerEscalationRisk', label: '经理升级风险', kind: 'risk' },
  ],
  payment_terms: [
    { key: 'paymentTerm', label: '付款条件', kind: 'text' },
    { key: 'triggerEvent', label: '触发事件', kind: 'text' },
    { key: 'preparationHours', label: '准备时长（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'completionSlaHours', label: '完成 SLA（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'blockingStage', label: '阻塞阶段', kind: 'stage' },
    { key: 'requiredDocuments', label: '所需文件', kind: 'string_list' },
    { key: 'responsibleFunction', label: '责任职能', kind: 'text' },
    { key: 'lcRequired', label: '是否需要信用证', kind: 'boolean' },
    { key: 'lcDetails', label: '信用证细节', kind: 'nullable_text' },
  ],
  logistics_planning: [
    { key: 'planningActivity', label: '物流计划活动', kind: 'text' },
    { key: 'bookingLeadTimeHours', label: '预订前置时长（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'capacityRequirement', label: '运力需求', kind: 'text' },
    { key: 'planningEvidence', label: '计划证据', kind: 'text' },
    { key: 'responsibleFunction', label: '责任职能', kind: 'text' },
  ],
  logistics_handover: [
    { key: 'handoverRequirement', label: '交接要求', kind: 'textarea' },
    { key: 'requiredEvidence', label: '交接证据', kind: 'string_list' },
    { key: 'documentTemplates', label: '文档模板', kind: 'string_list' },
    { key: 'handoverSlaHours', label: '交接 SLA（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'responsibleFunction', label: '责任职能', kind: 'text' },
  ],
  transit_monitoring: [
    { key: 'transitMilestone', label: '在途节点', kind: 'text' },
    { key: 'updateCadenceHours', label: '更新频率（小时）', kind: 'number', min: 1, max: 8760 },
    { key: 'exceptionTemplate', label: '异常模板', kind: 'textarea' },
    { key: 'escalationTemplate', label: '升级模板', kind: 'textarea' },
    { key: 'trackingEvidence', label: '跟踪证据', kind: 'text' },
    { key: 'responsibleFunction', label: '责任职能', kind: 'text' },
  ],
  regulatory_import_approval: [
    { key: 'approvalName', label: '审批名称', kind: 'text' },
    { key: 'authority', label: '主管机构', kind: 'text' },
    { key: 'dependencyRuleIds', label: '依赖规则 ID', kind: 'string_list' },
    { key: 'preparationHours', label: '准备时长（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'approvalSlaHours', label: '审批 SLA（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'requiredDocuments', label: '所需文件', kind: 'string_list' },
    { key: 'approvalEvidence', label: '审批证据', kind: 'text' },
    { key: 'responsibleFunction', label: '责任职能', kind: 'text' },
  ],
  customs_clearance: [
    { key: 'clearanceMilestone', label: '清关节点', kind: 'text' },
    { key: 'requiredDocuments', label: '清关文件', kind: 'string_list' },
    { key: 'blockingRuleIds', label: '阻塞规则 ID', kind: 'string_list' },
    { key: 'clearanceSlaHours', label: '清关 SLA（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'escalationTemplate', label: '升级模板', kind: 'textarea' },
    { key: 'clearanceEvidence', label: '清关证据', kind: 'text' },
    { key: 'responsibleFunction', label: '责任职能', kind: 'text' },
  ],
  quality_inspection_grn: [
    { key: 'inspectionType', label: '质检类型', kind: 'text' },
    { key: 'inspectionSlaHours', label: '质检 SLA（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'grnSlaHours', label: 'GRN SLA（小时）', kind: 'number', min: 0, max: 8760 },
    { key: 'requiredEvidence', label: '所需证据', kind: 'string_list' },
    { key: 'qualityOwnerRole', label: '质量责任角色', kind: 'text' },
    { key: 'grnOwnerRole', label: 'GRN 责任角色', kind: 'text' },
    { key: 'rejectionEscalationRole', label: '拒收升级角色', kind: 'text' },
    { key: 'acceptanceCriteria', label: '验收标准', kind: 'textarea' },
  ],
};

export const ADVANCED_SLA_V2_STATUSES = ['draft', 'active', 'inactive', 'retired'] as const;
export const ADVANCED_SLA_CALENDAR_MODES = ['elapsed_hours', 'tenant_business_days'] as const;
export type AdvancedSlaRuleV2Status = typeof ADVANCED_SLA_V2_STATUSES[number];
export type AdvancedSlaCalendarMode = typeof ADVANCED_SLA_CALENDAR_MODES[number];
type AdvancedSlaV2ParameterValue = string | number | boolean | string[] | null | undefined;
export type AdvancedSlaRuleV2Parameters = { domain: AdvancedSlaDomain } & Record<string, AdvancedSlaV2ParameterValue>;

export interface AdvancedSlaRuleV2Base {
  schemaVersion: 2;
  ruleId: string;
  name: string;
  domain: AdvancedSlaDomain;
  companyCode: string;
  businessUnit: string;
  stage: AdvancedSlaStage;
  route: AdvancedSlaRoute;
  risk: AdvancedSlaRisk;
  channel: AdvancedSlaChannel;
  effectiveFrom: string;
  effectiveTo: string | null;
  priority: number;
  status: AdvancedSlaRuleV2Status;
  createdBy: string;
  approvedBy: string | null;
  lastUpdated: string;
  notes: string | null;
  parameters: AdvancedSlaRuleV2Parameters;
}
export type AdvancedSlaRuleV2 = AdvancedSlaRuleV2Base;
export interface AdvancedSlaSectionV2 { domain: AdvancedSlaDomain; enabled: boolean; rules: AdvancedSlaRuleV2[] }

const v2Text = (max: number) => z.string().trim().min(1).max(max);
const v2OptionalText = (max: number) => v2Text(max).optional();
const v2Hours = z.number().finite().min(0).max(8760);
const v2PositiveHours = z.number().finite().min(1).max(8760);
const v2StringList = (allowEmpty = false) => {
  const schema = z.array(v2Text(300)).max(50).refine((items) => new Set(items).size === items.length, 'List values must be unique');
  return allowEmpty ? schema : schema.min(1);
};
const v2Country = z.string().trim().regex(/^[A-Z]{2}$/, 'Country must be an ISO 3166-1 alpha-2 code');
const v2Currency = z.string().trim().regex(/^[A-Z]{3}$/, 'Currency must be an ISO 4217 code');
const v2ActualRisk = z.enum(['high', 'medium', 'low']);
const v2IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected ISO date').refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}, 'Expected a real calendar date');
const v2UtcTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/, 'lastUpdated must be a UTC ISO datetime')
  .refine((value) => Number.isFinite(Date.parse(value)), 'lastUpdated must be a valid UTC ISO datetime');
const choices = (...values: string[]) => values.map((value) => ({ value, label: value }));
const yesNo = choices('Yes', 'No');
const stagesV2 = [
  { value: 'po_sent', label: 'Stage 1 — PO Sent' }, { value: 'supplier_commitment', label: 'Stage 2 — Supplier Commitment' },
  { value: 'fulfilment_production', label: 'Stage 3 — Fulfilment / Production' }, { value: 'dispatch_transit', label: 'Stage 4 — Dispatch / Transit' },
  { value: 'delivery_grn', label: 'Stage 5 — Delivery & Closure' },
] as const;
const functionsV2 = choices('Procurement', 'Finance', 'Logistics', 'Customs Broker', 'Compliance', 'QA', 'Warehouse', 'Supplier', 'Other');
const incotermsV2 = choices('EXW — Ex Works', 'FCA — Free Carrier', 'FOB — Free On Board', 'CFR — Cost and Freight', 'CIF — Cost, Insurance and Freight', 'CPT — Carriage Paid To', 'CIP — Carriage and Insurance Paid To', 'DAP — Delivered At Place', 'DPU — Delivered at Place Unloaded', 'DDP — Delivered Duty Paid');

/** Exact clean-room field order, labels, group headings, options and conditional controls observed in NaviSight. */
export const ADVANCED_SLA_V2_PARAMETER_FIELDS: Record<AdvancedSlaDomain, readonly AdvancedSlaParameterFieldDefinition[]> = {
  production_service_milestones: [
    { key: 'supplierCode', label: 'Supplier Code', kind: 'text', section: 'Scope' }, { key: 'supplierName', label: 'Supplier Name', kind: 'text', section: 'Scope' },
    { key: 'itemCode', label: 'Item Code', kind: 'text', section: 'Scope' }, { key: 'itemDescription', label: 'Item Description', kind: 'text', section: 'Scope' },
    { key: 'itemCategory', label: 'Item Category', kind: 'text', placeholder: 'Fabric, chemicals, service…', section: 'Scope' }, { key: 'processType', label: 'Process Type', kind: 'select', options: choices('Manufacturing', 'Service'), section: 'Scope' },
    { key: 'milestoneSequence', label: 'Milestone Sequence', kind: 'number', min: 1, max: 1000, required: true, section: 'Milestone' }, { key: 'milestoneName', label: 'Milestone Name', kind: 'text', placeholder: 'Yarn Procurement, Knitting…', required: true, section: 'Milestone' },
    { key: 'nextMilestone', label: 'Next Milestone', kind: 'text', section: 'Milestone' }, { key: 'blockingMilestone', label: 'Blocking Milestone', kind: 'select', options: yesNo, section: 'Milestone' },
    { key: 'standardDuration', label: 'Standard Duration', kind: 'number', min: 0, max: 8760, required: true, section: 'Timing' }, { key: 'durationType', label: 'Duration Type', kind: 'select', options: choices('Calendar Days', 'Working Days'), section: 'Timing' },
    { key: 'updateFrequency', label: 'Update Frequency', kind: 'select', options: choices('Daily', 'Every N Days', 'At Completion'), section: 'Timing' }, { key: 'updateFrequencyDays', label: 'Update Frequency Days', kind: 'number', min: 0, max: 3650, section: 'Timing' },
    { key: 'expectedStartEvidence', label: 'Expected Start Evidence', kind: 'text', section: 'Evidence' }, { key: 'expectedCompletionEvidence', label: 'Expected Completion Evidence', kind: 'text', section: 'Evidence' }, { key: 'supplierContactRole', label: 'Supplier Contact Role', kind: 'text', section: 'Evidence' },
  ],
  communication_escalation: [
    { key: 'supplierCode', label: 'Supplier Code', kind: 'text', section: 'Scope' }, { key: 'itemCode', label: 'Item Code', kind: 'text', section: 'Scope' },
    { key: 'stage', label: 'Stage', kind: 'select', options: stagesV2, required: true, section: 'Scope' }, { key: 'eventType', label: 'Event Type', kind: 'select', options: choices('PI Pending', 'Milestone Update', 'Document Pending', 'Payment Pending', 'Shipment Update', 'Inspection Pending', 'GRN Pending'), required: true, section: 'Scope' },
    { key: 'initialResponseSla', label: 'Initial Response SLA', kind: 'number', min: 0, max: 8760, required: true, section: 'Timing' }, { key: 'slaUnit', label: 'SLA Unit', kind: 'select', options: choices('Hours', 'Days'), section: 'Timing' },
    { key: 'reminder1After', label: 'Reminder 1 After', kind: 'number', min: 0, max: 8760, section: 'Timing' }, { key: 'reminder2After', label: 'Reminder 2 After', kind: 'number', min: 0, max: 8760, section: 'Timing' },
    { key: 'procurementManagerFlagAfter', label: 'Procurement Manager Flag After', kind: 'number', min: 0, max: 8760, section: 'Timing' }, { key: 'communicationChannel', label: 'Communication Channel', kind: 'select', options: choices('Email', 'WhatsApp', 'WeChat'), section: 'Timing' },
    { key: 'supplierEscalationLevel1', label: 'Supplier Escalation Level 1', kind: 'text', placeholder: 'Primary supplier contact', section: 'Escalation Levels' }, { key: 'supplierEscalationLevel2', label: 'Supplier Escalation Level 2', kind: 'text', placeholder: 'Supplier manager', section: 'Escalation Levels' }, { key: 'supplierEscalationLevel3', label: 'Supplier Escalation Level 3', kind: 'text', placeholder: 'Supplier senior management', section: 'Escalation Levels' },
    { key: 'riskAtReminder1', label: 'Risk at Reminder 1', kind: 'select', options: choices('Low', 'Medium', 'High'), section: 'Risk' }, { key: 'riskAtReminder2', label: 'Risk at Reminder 2', kind: 'select', options: choices('Low', 'Medium', 'High'), section: 'Risk' }, { key: 'riskAtEscalation', label: 'Risk at Escalation', kind: 'select', options: choices('Low', 'Medium', 'High'), section: 'Risk' },
  ],
  payment_terms: [
    { key: 'supplierCode', label: 'Supplier Code', kind: 'text', section: 'Terms' }, { key: 'paymentTerm', label: 'Payment Term', kind: 'select', options: choices('100% Advance', 'Partial Advance / Balance Before Shipment', 'Letter of Credit (LC)', 'Cash Against Documents (CAD)', 'Net 30', 'Net 60', 'Net 90', 'Open Account'), required: true, section: 'Terms' },
    { key: 'paymentTermDescription', label: 'Payment Term Description', kind: 'text', section: 'Terms' }, { key: 'triggerEvent', label: 'Trigger Event', kind: 'text', placeholder: 'PO issued, PI approved, BL issued…', section: 'Terms' }, { key: 'requiredAction', label: 'Required Action', kind: 'text', placeholder: 'Open LC, pay advance…', section: 'Terms' },
    { key: 'preparationLeadTime', label: 'Preparation Lead Time', kind: 'number', min: 0, max: 8760, section: 'Timing' }, { key: 'leadTimeUnit', label: 'Lead Time Unit', kind: 'select', options: choices('Hours', 'Days'), section: 'Timing' }, { key: 'completionSla', label: 'Completion SLA', kind: 'number', min: 0, max: 8760, section: 'Timing' }, { key: 'reminderRule', label: 'Reminder Rule', kind: 'text', section: 'Timing' }, { key: 'flagProcurementManagerAfter', label: 'Flag Procurement Manager After', kind: 'number', min: 0, max: 8760, section: 'Timing' },
    { key: 'blockingStage', label: 'Blocking Stage', kind: 'select', options: stagesV2, section: 'Dependencies' }, { key: 'blockingCondition', label: 'Blocking Condition', kind: 'text', placeholder: 'Production / shipment / document release blocked', section: 'Dependencies' },
    { key: 'requiredDocuments', label: 'Required Documents', kind: 'string_list', placeholder: 'PI, LC, SWIFT, Payment Advice', section: 'Documents' },
    { key: 'responsibleFunction', label: 'Responsible Function', kind: 'select', options: functionsV2, section: 'Ownership' }, { key: 'riskLevel', label: 'Risk Level', kind: 'select', options: choices('Low', 'Medium', 'High'), section: 'Ownership' },
    ...[
      { key: 'lcType', label: 'LC Type', kind: 'select', options: choices('Sight', 'Usance', 'Revolving', 'Transferable') }, { key: 'lcOpeningDeadline', label: 'LC Opening Deadline', kind: 'date' }, { key: 'lcPreparationLeadTime', label: 'LC Preparation Lead Time', kind: 'number', min: 0, max: 8760 },
      { key: 'lcExpiryDateRule', label: 'LC Expiry Date Rule', kind: 'text' }, { key: 'latestShipmentDateRule', label: 'Latest Shipment Date Rule', kind: 'text' }, { key: 'presentationPeriod', label: 'Presentation Period', kind: 'number', min: 0, max: 3650 },
      { key: 'partialShipmentAllowed', label: 'Partial Shipment Allowed', kind: 'select', options: yesNo }, { key: 'transshipmentAllowed', label: 'Transshipment Allowed', kind: 'select', options: yesNo }, { key: 'confirmationRequired', label: 'Confirmation Required', kind: 'select', options: yesNo },
      { key: 'advisingBankRequired', label: 'Advising Bank Required', kind: 'select', options: yesNo }, { key: 'negotiationBankRequired', label: 'Negotiation Bank Required', kind: 'select', options: yesNo }, { key: 'lcAmendmentSla', label: 'LC Amendment SLA', kind: 'number', min: 0, max: 8760 },
      { key: 'lcDocumentList', label: 'LC Document List', kind: 'string_list', placeholder: 'Commercial Invoice, BL, COO…' }, { key: 'discrepancyReviewSla', label: 'Discrepancy Review SLA', kind: 'number', min: 0, max: 8760 },
    ].map((field) => ({ ...field, section: 'LC Details', showWhen: { key: 'paymentTerm', equals: 'Letter of Credit (LC)' } })) as AdvancedSlaParameterFieldDefinition[],
  ],
  logistics_planning: [
    { key: 'incoterm', label: 'Incoterm', kind: 'select', options: incotermsV2, required: true, section: 'Route' }, { key: 'transportMode', label: 'Transport Mode', kind: 'select', options: choices('Sea', 'Air', 'Road', 'Courier'), section: 'Route' }, { key: 'originCountry', label: 'Origin Country', kind: 'text', section: 'Route' }, { key: 'originPort', label: 'Origin Port', kind: 'text', section: 'Route' }, { key: 'destinationCountry', label: 'Destination Country', kind: 'text', section: 'Route' }, { key: 'destinationPort', label: 'Destination Port', kind: 'text', section: 'Route' },
    { key: 'freightBookingOwner', label: 'Freight Booking Owner', kind: 'select', options: choices('Buyer', 'Supplier'), section: 'Ownership' }, { key: 'insuranceOwner', label: 'Insurance Owner', kind: 'select', options: choices('Buyer', 'Supplier'), section: 'Ownership' }, { key: 'responsibleFunction', label: 'Responsible Function', kind: 'select', options: functionsV2, section: 'Ownership' },
    { key: 'freightPlanningLeadTime', label: 'Freight Planning Lead Time', kind: 'number', min: 0, max: 8760, section: 'Lead Times' }, { key: 'bookingConfirmationLeadTime', label: 'Booking Confirmation Lead Time', kind: 'number', min: 0, max: 8760, section: 'Lead Times' }, { key: 'pickupPlanningLeadTime', label: 'Pickup Planning Lead Time', kind: 'number', min: 0, max: 8760, section: 'Lead Times' }, { key: 'finalDataDeadline', label: 'Final Data Deadline', kind: 'number', min: 0, max: 8760, section: 'Lead Times' },
    { key: 'tentativeBookingAllowed', label: 'Tentative Booking Allowed', kind: 'select', options: yesNo, section: 'Booking' }, { key: 'estimatedDataRequired', label: 'Estimated Data Required', kind: 'select', options: yesNo, section: 'Booking' }, { key: 'parallelLogisticsThreadRequired', label: 'Parallel Logistics Thread Required', kind: 'select', options: yesNo, section: 'Booking' }, { key: 'flagProcurementManagerAfter', label: 'Flag Procurement Manager After', kind: 'number', min: 0, max: 8760, section: 'Booking' },
  ],
  logistics_handover: [
    { key: 'supplierCode', label: 'Supplier Code', kind: 'text', section: 'Scope' }, { key: 'itemCode', label: 'Item Code', kind: 'text', section: 'Scope' }, { key: 'itemCategory', label: 'Item Category', kind: 'text', section: 'Scope' }, { key: 'incoterm', label: 'Incoterm', kind: 'select', options: incotermsV2, section: 'Scope' }, { key: 'originCountry', label: 'Origin Country', kind: 'text', section: 'Scope' }, { key: 'destinationCountry', label: 'Destination Country', kind: 'text', section: 'Scope' }, { key: 'transportMode', label: 'Transport Mode', kind: 'select', options: choices('Sea', 'Air', 'Road', 'Courier'), section: 'Scope' },
    { key: 'documentInformationName', label: 'Document / Information Name', kind: 'text', placeholder: 'Packing List, COO, CBM…', required: true, section: 'Requirement' }, { key: 'requirementType', label: 'Requirement Type', kind: 'select', options: choices('Document', 'Data', 'Approval'), section: 'Requirement' }, { key: 'requiredFrom', label: 'Required From', kind: 'select', options: choices('Supplier', 'Procurement', 'Other'), section: 'Requirement' }, { key: 'mandatory', label: 'Mandatory', kind: 'select', options: yesNo, section: 'Requirement' }, { key: 'validationRule', label: 'Validation Rule', kind: 'text', placeholder: 'Match PO, valid, signed…', section: 'Requirement' },
    { key: 'requiredByStage', label: 'Required By Stage', kind: 'select', options: stagesV2, section: 'Timing' }, { key: 'requiredByMilestone', label: 'Required By Milestone', kind: 'text', placeholder: 'Freight planning, booking, customs…', section: 'Timing' }, { key: 'tentativeOrFinal', label: 'Tentative or Final', kind: 'select', options: choices('Tentative', 'Final'), section: 'Timing' }, { key: 'flagProcurementManagerAfter', label: 'Flag Procurement Manager After', kind: 'number', min: 0, max: 8760, section: 'Timing' },
    { key: 'handoverRecipient', label: 'Handover Recipient', kind: 'text', placeholder: 'Logistics', section: 'Handover' }, { key: 'handoverMethod', label: 'Handover Method', kind: 'select', options: choices('System Thread', 'Upload', 'Email'), section: 'Handover' }, { key: 'missingItemRisk', label: 'Missing Item Risk', kind: 'select', options: choices('Low', 'Medium', 'High'), section: 'Handover' },
  ],
  transit_monitoring: [
    { key: 'transportMode', label: 'Transport Mode', kind: 'select', options: choices('Sea', 'Air', 'Road', 'Courier'), required: true, section: 'Route' }, { key: 'origin', label: 'Origin', kind: 'text', placeholder: 'Country / port', section: 'Route' }, { key: 'destination', label: 'Destination', kind: 'text', placeholder: 'Country / port', section: 'Route' },
    { key: 'standardTransitTime', label: 'Standard Transit Time', kind: 'number', min: 0, max: 8760, required: true, section: 'Timing' }, { key: 'transitTimeUnit', label: 'Transit Time Unit', kind: 'select', options: choices('Hours', 'Days'), section: 'Timing' }, { key: 'updateFrequency', label: 'Update Frequency', kind: 'select', options: choices('Daily', 'Every N Days', 'Milestone Based'), section: 'Timing' }, { key: 'noUpdateSla', label: 'No Update SLA', kind: 'number', min: 0, max: 8760, section: 'Timing' }, { key: 'etaChangeThreshold', label: 'ETA Change Threshold', kind: 'number', min: 0, max: 8760, section: 'Timing' },
    { key: 'requiredTransitEvents', label: 'Required Transit Events', kind: 'string_list', placeholder: 'Booking, ETD, ATD, ETA, arrival…', section: 'Events' }, { key: 'sourceOfUpdate', label: 'Source of Update', kind: 'select', options: choices('Supplier', 'Forwarder', 'Logistics', 'API'), section: 'Events' },
    { key: 'riskEscalationRule', label: 'Risk Escalation Rule', kind: 'select', options: choices('Low', 'Medium', 'High'), section: 'Risk' }, { key: 'flagProcurementManagerAfter', label: 'Flag Procurement Manager After', kind: 'number', min: 0, max: 8760, section: 'Risk' },
  ],
  regulatory_import_approval: [
    { key: 'itemCode', label: 'Item Code', kind: 'text', section: 'Scope' }, { key: 'itemCategory', label: 'Item Category', kind: 'text', section: 'Scope' }, { key: 'hsCode', label: 'HS Code', kind: 'text', section: 'Scope' }, { key: 'originCountry', label: 'Origin Country', kind: 'text', section: 'Scope' }, { key: 'destinationCountry', label: 'Destination Country', kind: 'text', required: true, section: 'Scope' }, { key: 'customerCode', label: 'Customer Code', kind: 'text', section: 'Scope' },
    { key: 'approvalDocumentName', label: 'Approval / Document Name', kind: 'text', placeholder: 'BOI approval, import licence…', required: true, section: 'Approval' }, { key: 'regulatoryAuthority', label: 'Regulatory Authority', kind: 'text', placeholder: 'BOI, Customs, Municipality…', section: 'Approval' }, { key: 'requiredBeforeStage', label: 'Required Before Stage', kind: 'select', options: stagesV2, section: 'Approval' }, { key: 'blockingCondition', label: 'Blocking Condition', kind: 'text', placeholder: 'Production / shipment / customs block', section: 'Approval' },
    { key: 'applicationLeadTime', label: 'Application Lead Time', kind: 'number', min: 0, max: 8760, section: 'Timing' }, { key: 'approvalValidity', label: 'Approval Validity', kind: 'text', placeholder: 'Expiry period', section: 'Timing' }, { key: 'renewalReminder', label: 'Renewal Reminder', kind: 'number', min: 0, max: 3650, section: 'Timing' }, { key: 'flagProcurementManagerAfter', label: 'Flag Procurement Manager After', kind: 'number', min: 0, max: 8760, section: 'Timing' },
    { key: 'responsibleFunction', label: 'Responsible Function', kind: 'select', options: functionsV2, section: 'Ownership' }, { key: 'requiredSupportingDocuments', label: 'Required Supporting Documents', kind: 'string_list', placeholder: 'MSDS, Health Certificate…', section: 'Ownership' },
  ],
  customs_clearance: [
    { key: 'destinationCountry', label: 'Destination Country', kind: 'text', required: true, section: 'Scope' }, { key: 'portAirport', label: 'Port / Airport', kind: 'text', section: 'Scope' }, { key: 'itemCategory', label: 'Item Category', kind: 'text', section: 'Scope' }, { key: 'hsCode', label: 'HS Code', kind: 'text', section: 'Scope' }, { key: 'customsBroker', label: 'Customs Broker', kind: 'text', section: 'Scope' },
    { key: 'preClearanceRequired', label: 'Pre-Clearance Required', kind: 'select', options: yesNo, section: 'Clearance' }, { key: 'preClearanceLeadTime', label: 'Pre-Clearance Lead Time', kind: 'number', min: 0, max: 8760, section: 'Clearance' }, { key: 'customsDocumentDeadline', label: 'Customs Document Deadline', kind: 'text', section: 'Clearance' }, { key: 'clearanceSla', label: 'Clearance SLA', kind: 'number', min: 0, max: 8760, section: 'Clearance' }, { key: 'customsUpdateFrequency', label: 'Customs Update Frequency', kind: 'select', options: choices('Daily', 'Event Based'), section: 'Clearance' },
    { key: 'dutyPaymentSla', label: 'Duty Payment SLA', kind: 'number', min: 0, max: 8760, section: 'Charges' }, { key: 'freeStorageDays', label: 'Free Storage Days', kind: 'number', min: 0, max: 3650, section: 'Charges' }, { key: 'demurrageStartDay', label: 'Demurrage Start Day', kind: 'number', min: 0, max: 3650, section: 'Charges' }, { key: 'detentionStartDay', label: 'Detention Start Day', kind: 'number', min: 0, max: 3650, section: 'Charges' },
    { key: 'responsibleFunction', label: 'Responsible Function', kind: 'select', options: functionsV2, section: 'Ownership' }, { key: 'flagProcurementManagerWhen', label: 'Flag Procurement Manager When', kind: 'text', placeholder: 'Defined trigger', section: 'Ownership' }, { key: 'riskEscalationLevel', label: 'Risk Escalation Level', kind: 'select', options: choices('Low', 'Medium', 'High'), section: 'Ownership' },
  ],
  quality_inspection_grn: [
    { key: 'itemCode', label: 'Item Code', kind: 'text', section: 'Scope' }, { key: 'itemCategory', label: 'Item Category', kind: 'text', section: 'Scope' }, { key: 'supplierCode', label: 'Supplier Code', kind: 'text', section: 'Scope' },
    { key: 'inspectionRequired', label: 'Inspection Required', kind: 'select', options: yesNo, section: 'Inspection' }, { key: 'inspectionType', label: 'Inspection Type', kind: 'select', options: choices('Supplier', 'Pre-shipment', 'Incoming', 'Laboratory'), section: 'Inspection' }, { key: 'inspectionOwner', label: 'Inspection Owner', kind: 'select', options: choices('QA', 'Warehouse', 'Third Party'), section: 'Inspection' }, { key: 'inspectionSla', label: 'Inspection SLA', kind: 'number', min: 0, max: 8760, section: 'Inspection' }, { key: 'requiredTestCheck', label: 'Required Test / Check', kind: 'text', placeholder: 'GSM, shade, quantity…', section: 'Inspection' },
    { key: 'acceptanceTolerance', label: 'Acceptance Tolerance', kind: 'text', placeholder: 'e.g. ±2%', section: 'Acceptance' }, { key: 'requiredInspectionDocument', label: 'Required Inspection Document', kind: 'text', placeholder: 'Inspection report, lab report', section: 'Acceptance' }, { key: 'qualityFailureAction', label: 'Quality Failure Action', kind: 'select', options: choices('Hold', 'Reject', 'Rework', 'Replace'), section: 'Acceptance' }, { key: 'supplierNotificationRequired', label: 'Supplier Notification Required', kind: 'select', options: yesNo, section: 'Acceptance' },
    { key: 'grnSla', label: 'GRN SLA', kind: 'number', min: 0, max: 8760, section: 'GRN' }, { key: 'partialGrnAllowed', label: 'Partial GRN Allowed', kind: 'select', options: yesNo, section: 'GRN' }, { key: 'flagProcurementManagerAfter', label: 'Flag Procurement Manager After', kind: 'number', min: 0, max: 8760, section: 'GRN' },
  ],
};

const legacyV2Keys = Object.fromEntries(ADVANCED_SLA_DOMAINS.map((domain) => [domain, ADVANCED_SLA_PARAMETER_FIELDS[domain].map((field) => field.key)])) as unknown as Record<AdvancedSlaDomain, readonly string[]>;
const legacyOptionalV2Keys: Record<AdvancedSlaDomain, readonly string[]> = {
  production_service_milestones: ['calendarMode', 'toleranceHours'], communication_escalation: ['messageTemplateId', 'internalOwnerRole', 'quietHoursPolicy'], payment_terms: ['currency', 'amountThreshold'],
  logistics_planning: ['carrierConfirmationHours'], logistics_handover: ['handoverLocation', 'custodyFromRole', 'custodyToRole', 'sealRequired'], transit_monitoring: ['etaToleranceHours', 'missedUpdateRisk', 'carrierRole'],
  regulatory_import_approval: ['jurisdictionCountry', 'permitType', 'expiryWarningDays'], customs_clearance: ['customsRegime', 'brokerRole', 'dutyPaymentSlaHours', 'demurrageRiskHours'], quality_inspection_grn: ['samplingPlan', 'defectTolerance', 'reinspectionSlaHours', 'grnBlockingRuleIds'],
};
function fieldSchema(field: AdvancedSlaParameterFieldDefinition): z.ZodTypeAny {
  if (field.kind === 'number') return z.number().finite().min(field.min ?? 0).max(field.max ?? 8760).optional();
  if (field.kind === 'boolean') return z.boolean().optional();
  if (field.kind === 'string_list') return v2StringList(true).optional();
  if (field.kind === 'date') return v2IsoDate.optional();
  if (field.kind === 'select') return z.string().trim().max(500).optional();
  return z.string().trim().max(field.kind === 'textarea' ? 2000 : 1000).optional();
}
function referenceParameterSchema(domain: AdvancedSlaDomain) {
  const fields = ADVANCED_SLA_V2_PARAMETER_FIELDS[domain];
  const shape: Record<string, z.ZodTypeAny> = { domain: z.literal(domain) };
  for (const field of fields) shape[field.key] = fieldSchema(field);
  for (const key of [...legacyV2Keys[domain], ...legacyOptionalV2Keys[domain]]) if (!(key in shape)) shape[key] = z.unknown().optional();
  return z.object(shape).strict().superRefine((value, context) => {
    const legacy = legacyV2Keys[domain].every((key) => value[key] !== undefined);
    if (legacy) return;
    for (const field of fields.filter((entry) => entry.required)) {
      const fieldValue = value[field.key];
      if (fieldValue === undefined || fieldValue === null || fieldValue === '') context.addIssue({ code: 'custom', path: [field.key], message: `${field.label} is required` });
    }
  });
}

export const ADVANCED_SLA_V2_PARAMETER_SCHEMAS = Object.fromEntries(ADVANCED_SLA_DOMAINS.map((domain) => [domain, referenceParameterSchema(domain)])) as Record<AdvancedSlaDomain, ReturnType<typeof referenceParameterSchema>>;

export function defaultAdvancedSlaV2Parameters(domain: AdvancedSlaDomain): AdvancedSlaRuleV2Parameters { return { domain }; }

export const advancedSlaRuleV2ParametersSchema = z.union([
  ADVANCED_SLA_V2_PARAMETER_SCHEMAS.production_service_milestones,
  ADVANCED_SLA_V2_PARAMETER_SCHEMAS.communication_escalation,
  ADVANCED_SLA_V2_PARAMETER_SCHEMAS.payment_terms,
  ADVANCED_SLA_V2_PARAMETER_SCHEMAS.logistics_planning,
  ADVANCED_SLA_V2_PARAMETER_SCHEMAS.logistics_handover,
  ADVANCED_SLA_V2_PARAMETER_SCHEMAS.transit_monitoring,
  ADVANCED_SLA_V2_PARAMETER_SCHEMAS.regulatory_import_approval,
  ADVANCED_SLA_V2_PARAMETER_SCHEMAS.customs_clearance,
  ADVANCED_SLA_V2_PARAMETER_SCHEMAS.quality_inspection_grn,
]);

export const advancedSlaRuleV2Schema = z.object({
  schemaVersion: z.literal(2), ruleId: v2Text(160), name: z.string().trim().max(200), domain: z.enum(ADVANCED_SLA_DOMAINS), companyCode: z.string().trim().max(100), businessUnit: z.string().trim().max(160),
  stage: z.enum(ADVANCED_SLA_STAGES), route: z.enum(ADVANCED_SLA_ROUTES), risk: z.enum(ADVANCED_SLA_RISKS), channel: z.enum(ADVANCED_SLA_CHANNELS),
  effectiveFrom: v2IsoDate, effectiveTo: v2IsoDate.nullable(), priority: z.number().int().min(0).max(1000), status: z.enum(ADVANCED_SLA_V2_STATUSES),
  createdBy: v2Text(300), approvedBy: v2Text(300).nullable(), lastUpdated: v2UtcTimestamp, notes: z.string().trim().max(2000).nullable(),
  parameters: advancedSlaRuleV2ParametersSchema,
}).strict().superRefine((value, context) => {
  if (value.domain !== value.parameters.domain) context.addIssue({ code: 'custom', path: ['parameters', 'domain'], message: 'parameters.domain must match rule domain' });
  if (value.effectiveTo !== null && value.effectiveTo < value.effectiveFrom) context.addIssue({ code: 'custom', path: ['effectiveTo'], message: 'effectiveTo must be on or after effectiveFrom' });
});

const advancedSlaSectionV2Schema = z.object({ domain: z.enum(ADVANCED_SLA_DOMAINS), enabled: z.boolean(), rules: z.array(advancedSlaRuleV2Schema) }).strict();
const advancedSlaV2SectionsSchema = z.array(advancedSlaSectionV2Schema).length(ADVANCED_SLA_DOMAINS.length);

function advancedSlaV2DependencyIds(rule: AdvancedSlaRuleV2): string[] {
  const parameters = rule.parameters;
  const key = parameters.domain === 'production_service_milestones' || parameters.domain === 'customs_clearance' ? 'blockingRuleIds'
    : parameters.domain === 'regulatory_import_approval' ? 'dependencyRuleIds' : parameters.domain === 'quality_inspection_grn' ? 'grnBlockingRuleIds' : null;
  const value = key ? parameters[key] : undefined;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  return [];
}

function assertAdvancedSlaV2Graph(rules: AdvancedSlaRuleV2[]): void {
  const ids = new Set(rules.map((rule) => rule.ruleId));
  if (ids.size !== rules.length) throw new AdvancedSlaContractError('Advanced SLA v2 ruleId must be unique');
  const dependencies = new Map(rules.map((rule) => [rule.ruleId, advancedSlaV2DependencyIds(rule)]));
  const state = new Map<string, 'visiting' | 'visited'>();
  const visit = (ruleId: string): void => {
    if (state.get(ruleId) === 'visited') return;
    if (state.get(ruleId) === 'visiting') throw new AdvancedSlaContractError(`Advanced SLA v2 dependency cycle includes ${ruleId}`);
    state.set(ruleId, 'visiting');
    for (const dependencyId of dependencies.get(ruleId) ?? []) {
      if (dependencyId === ruleId) throw new AdvancedSlaContractError(`Advanced SLA v2 rule ${ruleId} cannot depend on itself`);
      if (!ids.has(dependencyId)) throw new AdvancedSlaContractError(`Advanced SLA v2 dependency does not exist: ${dependencyId}`);
      visit(dependencyId);
    }
    state.set(ruleId, 'visited');
  };
  for (const ruleId of ids) visit(ruleId);
}

function scopesOverlap(left: AdvancedSlaRuleV2, right: AdvancedSlaRuleV2): boolean {
  if (left.status === 'retired' || right.status === 'retired') return false;
  const sameScope = left.domain === right.domain && left.companyCode === right.companyCode && left.businessUnit === right.businessUnit
    && left.stage === right.stage && left.route === right.route && left.risk === right.risk && left.channel === right.channel && left.priority === right.priority;
  if (!sameScope) return false;
  return left.effectiveFrom <= (right.effectiveTo ?? '9999-12-31') && right.effectiveFrom <= (left.effectiveTo ?? '9999-12-31');
}

/** Strict shared validator for JSON, form, CSV candidates, persistence readback and runtime evaluation. */
export function normalizeAdvancedSlaV2Sections(value: unknown): AdvancedSlaSectionV2[] {
  let parsed: AdvancedSlaSectionV2[];
  try { parsed = advancedSlaV2SectionsSchema.parse(value) as AdvancedSlaSectionV2[]; }
  catch (error) { throw new AdvancedSlaContractError(error instanceof z.ZodError ? z.prettifyError(error) : 'Advanced SLA v2 sections are invalid'); }
  for (const [index, section] of parsed.entries()) {
    if (section.domain !== ADVANCED_SLA_DOMAINS[index]) throw new AdvancedSlaContractError('Advanced SLA v2 sections must use the canonical nine-domain order');
    for (const rule of section.rules) {
      if (rule.domain !== section.domain || rule.parameters.domain !== section.domain) throw new AdvancedSlaContractError('Section, rule and parameters domain must match');
    }
  }
  const rules = parsed.flatMap((section) => section.rules);
  assertAdvancedSlaV2Graph(rules);
  for (let left = 0; left < rules.length; left += 1) {
    for (let right = left + 1; right < rules.length; right += 1) {
      if (scopesOverlap(rules[left]!, rules[right]!)) throw new AdvancedSlaContractError(`Advanced SLA v2 rules overlap at equal priority: ${rules[left]!.ruleId}, ${rules[right]!.ruleId}`);
    }
  }
  return parsed;
}

const ADVANCED_SLA_V2_CSV_INPUT_KEYS = [
  'schemaVersion', 'ruleId', 'name', 'domain', 'companyCode', 'businessUnit', 'stage', 'route', 'risk', 'channel',
  'effectiveFrom', 'effectiveTo', 'priority', 'status', 'notes',
] as const;
const snakeCase = (value: string): string => value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/** Flat, domain-specific CSV columns derived from the same strict Zod parameter shape. */
export function advancedSlaV2CsvColumns(domain: AdvancedSlaDomain): string[] {
  const parameterColumns = ADVANCED_SLA_V2_PARAMETER_FIELDS[domain].map((field) => snakeCase(field.key));
  return [...new Set([...ADVANCED_SLA_V2_CSV_INPUT_KEYS.map(snakeCase), ...parameterColumns])];
}

export class AdvancedSlaContractError extends Error {}

function advancedSlaDependencyIds(rule: AdvancedSlaRule): string[] {
  const parameters = rule.parameters;
  return parameters.domain === 'production_service_milestones' || parameters.domain === 'customs_clearance'
    ? parameters.blockingRuleIds
    : parameters.domain === 'regulatory_import_approval' ? parameters.dependencyRuleIds : [];
}

function assertAcyclicAdvancedSlaDependencies(rules: AdvancedSlaRule[]): void {
  const dependencyMap = new Map(rules.map((rule) => [rule.id, advancedSlaDependencyIds(rule)]));
  const state = new Map<string, 'visiting' | 'visited'>();
  const path: string[] = [];

  const visit = (ruleId: string): void => {
    if (state.get(ruleId) === 'visited') return;
    if (state.get(ruleId) === 'visiting') {
      const cycleStart = path.indexOf(ruleId);
      const cycle = [...path.slice(cycleStart >= 0 ? cycleStart : 0), ruleId];
      fail(`规则依赖不能形成循环: ${cycle.join(' -> ')}`);
    }
    state.set(ruleId, 'visiting');
    path.push(ruleId);
    for (const dependencyId of dependencyMap.get(ruleId) ?? []) visit(dependencyId);
    path.pop();
    state.set(ruleId, 'visited');
  };

  for (const ruleId of dependencyMap.keys()) visit(ruleId);
}

/** Normalize, bound, and reject unknown/cross-domain fields. */
export function normalizeAdvancedSlaSections(value: unknown): AdvancedSlaSection[] {
  if (!Array.isArray(value) || value.length !== ADVANCED_SLA_DOMAINS.length) fail('sections 必须包含全部九个领域');
  const ids = new Set<string>();
  const normalized: AdvancedSlaSection[] = value.map((candidate, sectionIndex) => {
    const section = record(candidate, `sections[${sectionIndex}]`);
    only(section, ['domain', 'enabled', 'rules']);
    const domain = enumValue(section['domain'], ADVANCED_SLA_DOMAINS, `sections[${sectionIndex}].domain`);
    if (domain !== ADVANCED_SLA_DOMAINS[sectionIndex]) fail('领域必须完整且采用规范顺序');
    if (typeof section['enabled'] !== 'boolean' || !Array.isArray(section['rules'])) fail(`sections[${sectionIndex}] 无效`);
    const rules = section['rules'].map((entry, ruleIndex) => {
      const rule = record(entry, `sections[${sectionIndex}].rules[${ruleIndex}]`);
      only(rule, ['id', 'name', 'enabled', 'scope', 'parameters']);
      const id = requiredText(rule['id'], 'rule.id', 160);
      if (ids.has(id)) fail(`规则 ID 重复: ${id}`);
      ids.add(id);
      const scopeValue = record(rule['scope'], 'scope');
      only(scopeValue, ['stage', 'route', 'risk', 'channel']);
      const scope: AdvancedSlaRuleScope = {
        stage: enumValue(scopeValue['stage'], ADVANCED_SLA_STAGES, 'scope.stage'),
        route: enumValue(scopeValue['route'], ADVANCED_SLA_ROUTES, 'scope.route'),
        risk: enumValue(scopeValue['risk'], ADVANCED_SLA_RISKS, 'scope.risk'),
        channel: enumValue(scopeValue['channel'], ADVANCED_SLA_CHANNELS, 'scope.channel'),
      };
      return {
        id,
        name: requiredText(rule['name'], 'rule.name', 200),
        enabled: booleanValue(rule['enabled'], 'rule.enabled'),
        scope,
        parameters: normalizeParameters(domain, rule['parameters']),
      };
    });
    return { domain, enabled: section['enabled'] as boolean, rules };
  });

  const rules = normalized.flatMap((section) => section.rules);
  for (const rule of rules) {
    const dependencies = advancedSlaDependencyIds(rule);
    for (const dependency of dependencies) {
      if (dependency === rule.id) fail(`规则 ${rule.id} 不能依赖自身`);
      if (!ids.has(dependency)) fail(`依赖规则不存在: ${dependency}`);
    }
  }
  assertAcyclicAdvancedSlaDependencies(rules);
  return normalized;
}

export function defaultAdvancedSlaParameters(domain: AdvancedSlaDomain): AdvancedSlaRuleParameters {
  switch (domain) {
    case 'production_service_milestones': return { domain, supplierScope: '', itemOrService: '', milestoneSequence: 1, blockingRuleIds: [], standardDurationHours: 0, updateCadenceHours: 1, startEvidence: '', completionEvidence: '', supplierContactRole: '' };
    case 'communication_escalation': return { domain, eventType: '', firstResponseHours: 0, firstReminderHours: 0, secondReminderHours: 0, managerEscalationHours: 0, escalationChannels: [], supplierLevel1Role: '', supplierLevel2Role: '', supplierLevel3Role: '', firstReminderRisk: 'low', secondReminderRisk: 'medium', managerEscalationRisk: 'high' };
    case 'payment_terms': return { domain, paymentTerm: '', triggerEvent: '', preparationHours: 0, completionSlaHours: 0, blockingStage: 'delivery_grn', requiredDocuments: [], responsibleFunction: '', lcRequired: false, lcDetails: null };
    case 'logistics_planning': return { domain, planningActivity: '', bookingLeadTimeHours: 0, capacityRequirement: '', planningEvidence: '', responsibleFunction: '' };
    case 'logistics_handover': return { domain, handoverRequirement: '', requiredEvidence: [], documentTemplates: [], handoverSlaHours: 0, responsibleFunction: '' };
    case 'transit_monitoring': return { domain, transitMilestone: '', updateCadenceHours: 1, exceptionTemplate: '', escalationTemplate: '', trackingEvidence: '', responsibleFunction: '' };
    case 'regulatory_import_approval': return { domain, approvalName: '', authority: '', dependencyRuleIds: [], preparationHours: 0, approvalSlaHours: 0, requiredDocuments: [], approvalEvidence: '', responsibleFunction: '' };
    case 'customs_clearance': return { domain, clearanceMilestone: '', requiredDocuments: [], blockingRuleIds: [], clearanceSlaHours: 0, escalationTemplate: '', clearanceEvidence: '', responsibleFunction: '' };
    case 'quality_inspection_grn': return { domain, inspectionType: '', inspectionSlaHours: 0, grnSlaHours: 0, requiredEvidence: [], qualityOwnerRole: '', grnOwnerRole: '', rejectionEscalationRole: '', acceptanceCriteria: '' };
  }
}

function normalizeParameters(domain: AdvancedSlaDomain, value: unknown): AdvancedSlaRuleParameters {
  const input = record(value, 'parameters');
  if (input['domain'] !== domain) fail(`parameters.domain 必须为 ${domain}`);
  switch (domain) {
    case 'production_service_milestones':
      only(input, ['domain', 'supplierScope', 'itemOrService', 'milestoneSequence', 'blockingRuleIds', 'standardDurationHours', 'updateCadenceHours', 'startEvidence', 'completionEvidence', 'supplierContactRole']);
      return { domain, supplierScope: requiredText(input['supplierScope'], 'supplierScope', 200), itemOrService: requiredText(input['itemOrService'], 'itemOrService', 300), milestoneSequence: integer(input['milestoneSequence'], 'milestoneSequence', 1, 1000), blockingRuleIds: stringList(input['blockingRuleIds'], 'blockingRuleIds', true), standardDurationHours: finiteNumber(input['standardDurationHours'], 'standardDurationHours', 0, 8760), updateCadenceHours: finiteNumber(input['updateCadenceHours'], 'updateCadenceHours', 1, 8760), startEvidence: requiredText(input['startEvidence'], 'startEvidence', 500), completionEvidence: requiredText(input['completionEvidence'], 'completionEvidence', 500), supplierContactRole: requiredText(input['supplierContactRole'], 'supplierContactRole', 200) };
    case 'communication_escalation': {
      only(input, ['domain', 'eventType', 'firstResponseHours', 'firstReminderHours', 'secondReminderHours', 'managerEscalationHours', 'escalationChannels', 'supplierLevel1Role', 'supplierLevel2Role', 'supplierLevel3Role', 'firstReminderRisk', 'secondReminderRisk', 'managerEscalationRisk']);
      const firstResponseHours = finiteNumber(input['firstResponseHours'], 'firstResponseHours', 0, 8760);
      const firstReminderHours = finiteNumber(input['firstReminderHours'], 'firstReminderHours', 0, 8760);
      const secondReminderHours = finiteNumber(input['secondReminderHours'], 'secondReminderHours', 0, 8760);
      const managerEscalationHours = finiteNumber(input['managerEscalationHours'], 'managerEscalationHours', 0, 8760);
      if (!(firstResponseHours <= firstReminderHours && firstReminderHours <= secondReminderHours && secondReminderHours <= managerEscalationHours)) fail('响应、提醒与升级时间必须按顺序递增');
      return { domain, eventType: requiredText(input['eventType'], 'eventType', 200), firstResponseHours, firstReminderHours, secondReminderHours, managerEscalationHours, escalationChannels: enumList(input['escalationChannels'], ADVANCED_SLA_CHANNELS, 'escalationChannels'), supplierLevel1Role: requiredText(input['supplierLevel1Role'], 'supplierLevel1Role', 200), supplierLevel2Role: requiredText(input['supplierLevel2Role'], 'supplierLevel2Role', 200), supplierLevel3Role: requiredText(input['supplierLevel3Role'], 'supplierLevel3Role', 200), firstReminderRisk: actualRisk(input['firstReminderRisk'], 'firstReminderRisk'), secondReminderRisk: actualRisk(input['secondReminderRisk'], 'secondReminderRisk'), managerEscalationRisk: actualRisk(input['managerEscalationRisk'], 'managerEscalationRisk') };
    }
    case 'payment_terms': {
      only(input, ['domain', 'paymentTerm', 'triggerEvent', 'preparationHours', 'completionSlaHours', 'blockingStage', 'requiredDocuments', 'responsibleFunction', 'lcRequired', 'lcDetails']);
      const lcRequired = booleanValue(input['lcRequired'], 'lcRequired');
      const lcDetails = input['lcDetails'] === null ? null : requiredText(input['lcDetails'], 'lcDetails', 1000);
      if (lcRequired && !lcDetails) fail('lcRequired 为 true 时 lcDetails 必填');
      if (!lcRequired && lcDetails !== null) fail('lcRequired 为 false 时 lcDetails 必须为 null');
      return { domain, paymentTerm: requiredText(input['paymentTerm'], 'paymentTerm', 200), triggerEvent: requiredText(input['triggerEvent'], 'triggerEvent', 200), preparationHours: finiteNumber(input['preparationHours'], 'preparationHours', 0, 8760), completionSlaHours: finiteNumber(input['completionSlaHours'], 'completionSlaHours', 0, 8760), blockingStage: enumValue(input['blockingStage'], ADVANCED_SLA_STAGES, 'blockingStage'), requiredDocuments: stringList(input['requiredDocuments'], 'requiredDocuments'), responsibleFunction: requiredText(input['responsibleFunction'], 'responsibleFunction', 200), lcRequired, lcDetails };
    }
    case 'logistics_planning':
      only(input, ['domain', 'planningActivity', 'bookingLeadTimeHours', 'capacityRequirement', 'planningEvidence', 'responsibleFunction']);
      return { domain, planningActivity: requiredText(input['planningActivity'], 'planningActivity', 300), bookingLeadTimeHours: finiteNumber(input['bookingLeadTimeHours'], 'bookingLeadTimeHours', 0, 8760), capacityRequirement: requiredText(input['capacityRequirement'], 'capacityRequirement', 300), planningEvidence: requiredText(input['planningEvidence'], 'planningEvidence', 500), responsibleFunction: requiredText(input['responsibleFunction'], 'responsibleFunction', 200) };
    case 'logistics_handover':
      only(input, ['domain', 'handoverRequirement', 'requiredEvidence', 'documentTemplates', 'handoverSlaHours', 'responsibleFunction']);
      return { domain, handoverRequirement: requiredText(input['handoverRequirement'], 'handoverRequirement', 1000), requiredEvidence: stringList(input['requiredEvidence'], 'requiredEvidence'), documentTemplates: stringList(input['documentTemplates'], 'documentTemplates'), handoverSlaHours: finiteNumber(input['handoverSlaHours'], 'handoverSlaHours', 0, 8760), responsibleFunction: requiredText(input['responsibleFunction'], 'responsibleFunction', 200) };
    case 'transit_monitoring':
      only(input, ['domain', 'transitMilestone', 'updateCadenceHours', 'exceptionTemplate', 'escalationTemplate', 'trackingEvidence', 'responsibleFunction']);
      return { domain, transitMilestone: requiredText(input['transitMilestone'], 'transitMilestone', 300), updateCadenceHours: finiteNumber(input['updateCadenceHours'], 'updateCadenceHours', 1, 8760), exceptionTemplate: requiredText(input['exceptionTemplate'], 'exceptionTemplate', 1000), escalationTemplate: requiredText(input['escalationTemplate'], 'escalationTemplate', 1000), trackingEvidence: requiredText(input['trackingEvidence'], 'trackingEvidence', 500), responsibleFunction: requiredText(input['responsibleFunction'], 'responsibleFunction', 200) };
    case 'regulatory_import_approval':
      only(input, ['domain', 'approvalName', 'authority', 'dependencyRuleIds', 'preparationHours', 'approvalSlaHours', 'requiredDocuments', 'approvalEvidence', 'responsibleFunction']);
      return { domain, approvalName: requiredText(input['approvalName'], 'approvalName', 300), authority: requiredText(input['authority'], 'authority', 300), dependencyRuleIds: stringList(input['dependencyRuleIds'], 'dependencyRuleIds', true), preparationHours: finiteNumber(input['preparationHours'], 'preparationHours', 0, 8760), approvalSlaHours: finiteNumber(input['approvalSlaHours'], 'approvalSlaHours', 0, 8760), requiredDocuments: stringList(input['requiredDocuments'], 'requiredDocuments'), approvalEvidence: requiredText(input['approvalEvidence'], 'approvalEvidence', 500), responsibleFunction: requiredText(input['responsibleFunction'], 'responsibleFunction', 200) };
    case 'customs_clearance':
      only(input, ['domain', 'clearanceMilestone', 'requiredDocuments', 'blockingRuleIds', 'clearanceSlaHours', 'escalationTemplate', 'clearanceEvidence', 'responsibleFunction']);
      return { domain, clearanceMilestone: requiredText(input['clearanceMilestone'], 'clearanceMilestone', 300), requiredDocuments: stringList(input['requiredDocuments'], 'requiredDocuments'), blockingRuleIds: stringList(input['blockingRuleIds'], 'blockingRuleIds', true), clearanceSlaHours: finiteNumber(input['clearanceSlaHours'], 'clearanceSlaHours', 0, 8760), escalationTemplate: requiredText(input['escalationTemplate'], 'escalationTemplate', 1000), clearanceEvidence: requiredText(input['clearanceEvidence'], 'clearanceEvidence', 500), responsibleFunction: requiredText(input['responsibleFunction'], 'responsibleFunction', 200) };
    case 'quality_inspection_grn':
      only(input, ['domain', 'inspectionType', 'inspectionSlaHours', 'grnSlaHours', 'requiredEvidence', 'qualityOwnerRole', 'grnOwnerRole', 'rejectionEscalationRole', 'acceptanceCriteria']);
      return { domain, inspectionType: requiredText(input['inspectionType'], 'inspectionType', 300), inspectionSlaHours: finiteNumber(input['inspectionSlaHours'], 'inspectionSlaHours', 0, 8760), grnSlaHours: finiteNumber(input['grnSlaHours'], 'grnSlaHours', 0, 8760), requiredEvidence: stringList(input['requiredEvidence'], 'requiredEvidence'), qualityOwnerRole: requiredText(input['qualityOwnerRole'], 'qualityOwnerRole', 200), grnOwnerRole: requiredText(input['grnOwnerRole'], 'grnOwnerRole', 200), rejectionEscalationRole: requiredText(input['rejectionEscalationRole'], 'rejectionEscalationRole', 200), acceptanceCriteria: requiredText(input['acceptanceCriteria'], 'acceptanceCriteria', 1000) };
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} 必须为对象`);
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`不允许的字段: ${key}`);
}
function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${field} 无效`);
  return value.trim();
}
function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') fail(`${field} 必须为布尔值`);
  return value;
}
function finiteNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${field} 必须是 ${min} 到 ${max} 的有限数字`);
  return value;
}
function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(`${field} 必须是 ${min} 到 ${max} 的整数`);
  return Number(value);
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(`${field} 无效`);
  return value as T;
}
function enumList<T extends string>(value: unknown, allowed: readonly T[], field: string): T[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${field} 不能为空`);
  const normalized = value.map((entry) => enumValue(entry, allowed, field));
  if (new Set(normalized).size !== normalized.length) fail(`${field} 不可重复`);
  return normalized;
}
function actualRisk(value: unknown, field: string): Exclude<AdvancedSlaRisk, 'all'> {
  return enumValue(value, ['high', 'medium', 'low'] as const, field);
}
function stringList(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 50) fail(`${field} 必须是${allowEmpty ? '' : '非空'}字符串数组`);
  const normalized = value.map((entry) => requiredText(entry, field, 300));
  if (new Set(normalized).size !== normalized.length) fail(`${field} 不可重复`);
  return normalized;
}
function fail(message: string): never { throw new AdvancedSlaContractError(message); }
