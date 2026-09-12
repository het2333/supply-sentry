import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ADVANCED_SLA_DOMAINS as ADVANCED_SLA_V2_DOMAINS,
  advancedSlaV2CsvColumns,
  type AdvancedSlaDomain,
  type AdvancedSlaRuleV2,
  type AdvancedSlaSectionV2,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type Supplier,
} from '@readywork/core';
import { openPersistence } from '@readywork/persistence';
import { normalizeAdvancedSlaDashboard } from '../../console/features/procurement/advanced-sla-view-model.js';
import type { Session } from '../src/auth.js';
import { advancedSlaAutoSendDecision, handleProcurementAdvancedSlaRequest, validateAdvancedSlaSections } from '../src/procurement-advanced-sla.js';

const tenantId = 'tenant:advanced-sla';
const manager: Session = { username: 'manager', tenantId, humanId: 'human:manager', name: '王经理', role: '采购经理', expiresAt: Date.now() + 60_000 };
const buyer: Session = { username: 'buyer', tenantId, humanId: 'human:buyer', name: '李采购', role: '采购专员', expiresAt: Date.now() + 60_000 };
const otherManager: Session = { ...manager, tenantId: 'tenant:other', humanId: 'human:other' };

const domains = [
  'production_service_milestones', 'communication_escalation', 'payment_terms', 'logistics_planning', 'logistics_handover',
  'transit_monitoring', 'regulatory_import_approval', 'customs_clearance', 'quality_inspection_grn',
];
const domainParameters = {
  production_service_milestones: {
    domain: 'production_service_milestones', supplierScope: '指定供应商', itemOrService: '液压阀', milestoneSequence: 1,
    blockingRuleIds: [], standardDurationHours: 48, updateCadenceHours: 12, startEvidence: '工单启动回执', completionEvidence: '完工检验报告', supplierContactRole: '生产计划经理',
  },
  communication_escalation: {
    domain: 'communication_escalation', eventType: 'supplier_confirmation_overdue', firstResponseHours: 4, firstReminderHours: 8,
    secondReminderHours: 16, managerEscalationHours: 24, escalationChannels: ['email', 'whatsapp'], supplierLevel1Role: '跟单员',
    supplierLevel2Role: '销售经理', supplierLevel3Role: '总经理', firstReminderRisk: 'low', secondReminderRisk: 'medium', managerEscalationRisk: 'high',
  },
  payment_terms: {
    domain: 'payment_terms', paymentTerm: 'Net 30', triggerEvent: '合格 GRN', preparationHours: 24, completionSlaHours: 72,
    blockingStage: 'delivery_grn', requiredDocuments: ['发票', 'GRN'], responsibleFunction: '应付会计', lcRequired: true, lcDetails: '可撤销即期信用证',
  },
  logistics_planning: {
    domain: 'logistics_planning', planningActivity: '舱位与车辆预订', bookingLeadTimeHours: 72, capacityRequirement: '20GP x 1',
    planningEvidence: '承运人订舱确认', responsibleFunction: '物流计划',
  },
  logistics_handover: {
    domain: 'logistics_handover', handoverRequirement: '封箱前交接核验', requiredEvidence: ['装箱清单', '封签照片'], documentTemplates: ['handover-checklist-v2'],
    handoverSlaHours: 12, responsibleFunction: '仓库与物流',
  },
  transit_monitoring: {
    domain: 'transit_monitoring', transitMilestone: '到达目的港', updateCadenceHours: 24, exceptionTemplate: '运输异常通知 v1',
    escalationTemplate: '运输升级 v1', trackingEvidence: '承运人轨迹回执', responsibleFunction: '运输控制塔',
  },
  regulatory_import_approval: {
    domain: 'regulatory_import_approval', approvalName: '进口许可审批', authority: '海关与行业主管部门', dependencyRuleIds: [],
    preparationHours: 48, approvalSlaHours: 120, requiredDocuments: ['许可申请', '原产地证'], approvalEvidence: '审批回执编号', responsibleFunction: '合规',
  },
  customs_clearance: {
    domain: 'customs_clearance', clearanceMilestone: '报关申报', requiredDocuments: ['商业发票', '装箱单'], blockingRuleIds: ['rule-7'],
    clearanceSlaHours: 48, escalationTemplate: '清关滞留升级 v2', clearanceEvidence: '放行单', responsibleFunction: '关务',
  },
  quality_inspection_grn: {
    domain: 'quality_inspection_grn', inspectionType: '到货全检', inspectionSlaHours: 24, grnSlaHours: 8,
    requiredEvidence: ['检验报告', '收货照片'], qualityOwnerRole: '质量经理', grnOwnerRole: '仓库主管', rejectionEscalationRole: '采购总监', acceptanceCriteria: 'AQL 1.0',
  },
} as const;

const domainSpecificSections = domains.map((domain, index) => ({
  domain,
  enabled: true,
  rules: [{
    id: `rule-${index + 1}`,
    name: `${domain} contract`,
    enabled: true,
    scope: { stage: index === 0 ? 'supplier_commitment' : 'po_sent', route: index === 0 ? 'import' : 'all', risk: index === 0 ? 'high' : 'all', channel: 'email' },
    parameters: structuredClone(domainParameters[domain as keyof typeof domainParameters]),
  }],
}));

function csvCell(value: string): string { return `"${value.replaceAll('"', '""')}"`; }
const domainSpecificCsv = `domain,rule_id,name,enabled,scope_json,parameters_json\n${domainSpecificSections.map((section) => {
  const rule = section.rules[0]!;
  return [section.domain, rule.id, rule.name, 'true', csvCell(JSON.stringify(rule.scope)), csvCell(JSON.stringify(rule.parameters))].join(',');
}).join('\n')}`;
const sections = domainSpecificSections;
const importedSections = domainSpecificSections.map((section, index) => {
  const next = structuredClone(section) as Record<string, any>;
  next.rules[0].id = `csv-${index + 1}`;
  next.rules[0].name = 'CSV rule';
  if (next.domain === 'customs_clearance') next.rules[0].parameters.blockingRuleIds = ['csv-7'];
  return next;
});
const csv = `domain,rule_id,name,enabled,scope_json,parameters_json\n${importedSections.map((section) => {
  const rule = section.rules[0]!;
  return [section.domain, rule.id, rule.name, 'true', csvCell(JSON.stringify(rule.scope)), csvCell(JSON.stringify(rule.parameters))].join(',');
}).join('\n')}`;

async function startAdvancedSlaApi(store: ReturnType<typeof openPersistence>, at = '2026-08-30T01:00:00.000Z') {
  const server = createServer((req, res) => {
    const token = String(req.headers.authorization ?? '').replace('Bearer ', '');
    const session = token === 'manager' ? manager : token === 'buyer' ? buyer : token === 'other' ? otherManager : null;
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void handleProcurementAdvancedSlaRequest(req, res, path, req.method ?? 'GET', { db: store.db, session, now: () => new Date(at) })
      .then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error: unknown) => res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    async request(path: string, method = 'GET', token = 'manager', body?: Record<string, unknown>) {
      const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    },
    async requestRaw(path: string, method = 'GET', token = 'manager', body?: Record<string, unknown>) {
      const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, contentType: response.headers.get('content-type'), text: await response.text() };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function v2Rule(domain: AdvancedSlaDomain, index: number): AdvancedSlaRuleV2 {
  const shared = {
    schemaVersion: 2 as const, ruleId: `v2-rule-${index}`, name: `${domain} v2`, domain, companyCode: 'RW-CN', businessUnit: 'Procurement',
    stage: 'supplier_commitment' as const, route: 'import' as const, risk: 'all' as const, channel: 'email' as const,
    effectiveFrom: '2026-09-03', effectiveTo: null, priority: index, status: 'draft' as const, createdBy: manager.humanId,
    approvedBy: null, lastUpdated: '2026-09-03T04:00:00.000Z', notes: null,
  };
  const parameters = domain === 'production_service_milestones' ? { domain, supplierScope: 'Approved', itemOrService: 'Valve', milestoneSequence: 1, blockingRuleIds: [], standardDurationHours: 48, updateCadenceHours: 8, startEvidence: 'Start', completionEvidence: 'Complete', supplierContactRole: 'Planner' }
    : domain === 'communication_escalation' ? { domain, eventType: 'overdue', firstResponseHours: 4, firstReminderHours: 8, secondReminderHours: 16, managerEscalationHours: 24, escalationChannels: ['email'] as const, supplierLevel1Role: 'Planner', supplierLevel2Role: 'Manager', supplierLevel3Role: 'Director', firstReminderRisk: 'low' as const, secondReminderRisk: 'medium' as const, managerEscalationRisk: 'high' as const }
    : domain === 'payment_terms' ? { domain, paymentTerm: 'Net 30', triggerEvent: 'GRN', preparationHours: 24, completionSlaHours: 72, blockingStage: 'delivery_grn' as const, requiredDocuments: ['Invoice'], responsibleFunction: 'AP', lcRequired: false, lcDetails: null }
    : domain === 'logistics_planning' ? { domain, planningActivity: 'Book capacity', bookingLeadTimeHours: 72, capacityRequirement: '20GP', planningEvidence: 'Booking', responsibleFunction: 'Logistics', transportMode: 'ocean', incoterm: 'FOB', originCountry: 'CN', destinationCountry: 'DE', carrierConfirmationHours: 12 }
    : domain === 'logistics_handover' ? { domain, handoverRequirement: 'Verify cartons', requiredEvidence: ['Packing list'], documentTemplates: ['handover-v2'], handoverSlaHours: 12, responsibleFunction: 'Warehouse' }
    : domain === 'transit_monitoring' ? { domain, transitMilestone: 'Port arrival', updateCadenceHours: 24, exceptionTemplate: 'Exception', escalationTemplate: 'Escalation', trackingEvidence: 'Carrier event', responsibleFunction: 'Logistics' }
    : domain === 'regulatory_import_approval' ? { domain, approvalName: 'Permit', authority: 'Customs', dependencyRuleIds: [], preparationHours: 48, approvalSlaHours: 120, requiredDocuments: ['Application'], approvalEvidence: 'Permit', responsibleFunction: 'Compliance' }
    : domain === 'customs_clearance' ? { domain, clearanceMilestone: 'Declaration', requiredDocuments: ['Invoice'], blockingRuleIds: [], clearanceSlaHours: 24, escalationTemplate: 'Escalation', clearanceEvidence: 'Release', responsibleFunction: 'Compliance' }
    : { domain, inspectionType: 'Inbound', inspectionSlaHours: 24, grnSlaHours: 8, requiredEvidence: ['Inspection'], qualityOwnerRole: 'Quality', grnOwnerRole: 'Warehouse', rejectionEscalationRole: 'Manager', acceptanceCriteria: 'No critical defects' };
  return { ...shared, parameters } as AdvancedSlaRuleV2;
}

function v2Sections(): AdvancedSlaSectionV2[] {
  return ADVANCED_SLA_V2_DOMAINS.map((domain, index) => ({ domain, enabled: true, rules: [v2Rule(domain, index + 1)] }));
}

function v2WritableSections(): Array<Record<string, unknown>> {
  return v2Sections().map((section) => ({ ...section, rules: section.rules.map(({ createdBy: _createdBy, approvedBy: _approvedBy, lastUpdated: _lastUpdated, ...rule }) => rule) }));
}

function logisticsPlanningV2Csv(ruleId = 'csv-logistics'): string {
  const domain = 'logistics_planning' as const;
  const columns = advancedSlaV2CsvColumns(domain);
  const row: Record<string, string> = {
    schema_version: '2', rule_id: ruleId, name: 'Validated logistics plan', domain, company_code: 'RW-CN', business_unit: 'Procurement',
    stage: 'supplier_commitment', route: 'import', risk: 'all', channel: 'email', effective_from: '2026-09-04', effective_to: '', priority: '100', status: 'active', notes: 'Validated import',
    planning_activity: 'Reserve vessel capacity', booking_lead_time_hours: '96', capacity_requirement: '40HQ x 1', planning_evidence: 'Carrier confirmation', responsible_function: 'Logistics',
    transport_mode: 'ocean', incoterm: 'FOB', origin_country: 'CN', destination_country: 'DE', carrier_confirmation_hours: '12',
  };
  return [columns.join(','), columns.map((column) => csvCell(row[column] ?? '')).join(',')].join('\n');
}

test('Advanced SLA validates and preserves the complete discriminated parameter contract for all nine domains (catches generic or lossy schemas)', () => {
  assert.deepEqual(validateAdvancedSlaSections(domainSpecificSections), domainSpecificSections);
  const unknown = structuredClone(domainSpecificSections) as Array<Record<string, any>>;
  unknown[0]!.rules[0]!.parameters.unexpected = 'must fail';
  assert.throws(() => validateAdvancedSlaSections(unknown), /unexpected/);
  const crossDomain = structuredClone(domainSpecificSections) as Array<Record<string, any>>;
  crossDomain[0]!.rules[0]!.parameters.paymentTerm = 'Net 90';
  assert.throws(() => validateAdvancedSlaSections(crossDomain), /paymentTerm/);
  const cyclic = structuredClone(domainSpecificSections) as Array<Record<string, any>>;
  const secondMilestone = structuredClone(cyclic[0]!.rules[0]!);
  secondMilestone.id = 'rule-1b';
  secondMilestone.name = 'Second milestone';
  secondMilestone.parameters.milestoneSequence = 2;
  secondMilestone.parameters.blockingRuleIds = ['rule-1'];
  cyclic[0]!.rules[0]!.parameters.blockingRuleIds = ['rule-1b'];
  cyclic[0]!.rules.push(secondMilestone);
  assert.throws(() => validateAdvancedSlaSections(cyclic), /规则依赖不能形成循环: rule-1 -> rule-1b -> rule-1/);
});

test('Advanced SLA JSON create-read-edit-save round trip preserves every accepted key in all nine domains (catches persisted data loss)', async () => {
  const store = openPersistence(':memory:', { tenantId });
  const api = await startAdvancedSlaApi(store);
  try {
    const created = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { name: 'Nine domains', sections: domainSpecificSections, autoSend: { enabled: false, stages: [], channels: [], risks: [] } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(created.body.item.sections, domainSpecificSections);
    const updated = await api.request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(String(created.body.item.id))}`, 'PATCH', 'manager', { expectedVersion: 1, name: 'Nine domains edited', sections: created.body.item.sections, autoSend: created.body.item.autoSend });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.deepEqual(updated.body.item.sections, domainSpecificSections);
    const root = await api.request('/api/procurement/advanced-sla');
    assert.deepEqual(root.body.draftProfiles[0].sections, domainSpecificSections);
  } finally { await api.close(); store.close(); }
});

test('Advanced SLA keeps legacy CSV preview readable but blocks v1 apply and implicit publish', async () => {
  const store = openPersistence(':memory:', { tenantId });
  const api = await startAdvancedSlaApi(store);
  try {
    const created = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { name: 'CSV target', sections: domainSpecificSections, autoSend: { enabled: false, stages: [], channels: [], risks: [] } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const preview = await api.request('/api/procurement/advanced-sla/imports/preview', 'POST', 'manager', { profileId: created.body.item.id, expectedVersion: 1, csv: domainSpecificCsv });
    assert.equal(preview.status, 201, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.item.sections, domainSpecificSections);
    const applied = await api.request(`/api/procurement/advanced-sla/imports/${encodeURIComponent(String(preview.body.item.id))}/apply`, 'POST', 'manager', { expectedBatchVersion: 1, expectedProfileVersion: 1 });
    assert.equal(applied.status, 422, JSON.stringify(applied.body));
    assert.equal(applied.body.code, 'ADVANCED_SLA_V2_REQUIRED');
    const root = await api.request('/api/procurement/advanced-sla');
    assert.equal(root.body.publishedProfile, null);
    assert.deepEqual(root.body.draftProfiles[0].sections, domainSpecificSections);
    assert.equal(root.body.importHistory.find((item: Record<string, unknown>) => item.id === preview.body.item.id).status, 'previewed');
  } finally { await api.close(); store.close(); }
});

test('Advanced SLA impact previews bind to the exact manual or CSV candidate and match only active PO facts in enabled scope (catches published/all-or-zero previews)', async () => {
  const store = openPersistence(':memory:', { tenantId });
  const api = await startAdvancedSlaApi(store);
  const at = '2026-08-30T00:00:00.000Z';
  const savePo = (id: string, status: string, route: 'local' | 'import') => {
    const publishedHigh = id.includes('-high');
    const supplier: Supplier = {
      id: `supplier:${id}`, tenantId, sourceSystem: 'test', externalId: `SUP-${id}`, status: 'active', createdAt: at, updatedAt: at,
      name: `Supplier ${id}`, currency: 'CNY', contacts: [], performanceScore: publishedHigh ? 0 : 100,
    };
    const po = {
      id, tenantId, sourceSystem: 'test', externalId: id, status, createdAt: at, updatedAt: at, supplierId: supplier.id,
      currency: 'CNY', orderedAt: at, route, requiredInHouseAt: publishedHigh ? '2026-08-01T00:00:00.000Z' : '2026-12-31T00:00:00.000Z',
    } as unknown as PurchaseOrder;
    const line: PurchaseOrderLine = {
      id: `line:${id}`, poId: id, lineNumber: '10', itemId: `item:${id}`, description: `Item ${id}`,
      uom: 'EA', orderedQty: 1, unitPrice: 100, currency: 'CNY',
    };
    store.procurement.saveDocument('supplier', supplier);
    store.procurement.saveDocument('purchase_order', po);
    store.procurement.saveLine('purchase_order_line', id, line);
    store.db.prepare(`INSERT INTO procurement_supplier_operating_profiles
      (tenant_id,supplier_id,version,country_code,route,supplier_type,industry,address_json,primary_material_code,primary_material_name,
       default_lead_time_days,product_criticality,payment_terms,contract_starts_on,contract_ends_on,status,created_at,updated_at)
      VALUES (?,?,1,'CN',?,'manufacturer','','null','','',7,?,'','2026-01-01','2026-12-31','active',?,?)`)
      .run(tenantId, supplier.id, route, publishedHigh ? 'high' : 'low', at, at);
  };
  const highRisk = (poId: string) => store.exceptions.save({ id: `exception:${poId}`, type: 'delivery_risk', severity: 'high', objectId: poId, objectType: 'purchase_order', aiJudgment: 'literal high-risk fact', recommendedAction: 'review', context: {}, needsApproval: false, status: 'open', createdAt: at });
  savePo('po:import-high', 'sent', 'import'); highRisk('po:import-high');
  savePo('po:import-low', 'sent', 'import');
  savePo('po:local-high', 'sent', 'local'); highRisk('po:local-high');
  savePo('po:import-dispatch-high', 'shipped', 'import'); highRisk('po:import-dispatch-high');
  savePo('po:closed-high', 'closed', 'import'); highRisk('po:closed-high');
  const scopedSections = structuredClone(domainSpecificSections) as Array<Record<string, any>>;
  for (const [index, section] of scopedSections.entries()) if (index > 0) section.rules = [];
  const publishedSections = structuredClone(scopedSections);
  publishedSections[0]!.rules[0]!.scope = { stage: 'supplier_commitment', route: 'all', risk: 'all', channel: 'email' };
  const csvSections = structuredClone(scopedSections);
  csvSections[0]!.rules[0]!.scope = { stage: 'supplier_commitment', route: 'import', risk: 'all', channel: 'email' };
  const csvCandidateSections = csvSections.map((section, index) => {
    if (section.rules.length) return section;
    const source = structuredClone(domainSpecificSections[index]!.rules[0]!) as Record<string, any>;
    source.id = `disabled-domain-${index}`; source.name = 'Disabled placeholder'; source.enabled = false;
    if (source.parameters.domain === 'regulatory_import_approval') source.parameters.dependencyRuleIds = [];
    if (source.parameters.domain === 'customs_clearance') source.parameters.blockingRuleIds = [];
    return { ...section, rules: [source] };
  });
  const scopedCsv = `domain,rule_id,name,enabled,scope_json,parameters_json\n${csvCandidateSections.flatMap((section) => section.rules.map((rule: Record<string, any>) => [section.domain, rule.id, rule.name, String(rule.enabled), csvCell(JSON.stringify(rule.scope)), csvCell(JSON.stringify(rule.parameters))].join(','))).join('\n')}`;
  try {
    const initial = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { schemaVersion: 2, name: 'Current published', sections: v2WritableSections(), autoSend: { enabled: false, stages: [], channels: [], risks: [] } });
    assert.equal(initial.status, 201, JSON.stringify(initial.body));
    assert.equal((await api.request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(String(initial.body.item.id))}/publish`, 'POST', 'manager', { expectedVersion: 1 })).status, 200);
    const draft = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { name: 'Pending exact candidate', sections: scopedSections, autoSend: { enabled: false, stages: [], channels: [], risks: [] } });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const root = await api.request('/api/procurement/advanced-sla');
    assert.deepEqual(root.body.impactPreview, { candidateType: 'profile', candidateId: draft.body.item.id, candidateVersion: 1, profileId: draft.body.item.id, profileVersion: 1, activePurchaseOrders: 4, matchedPurchaseOrders: 1 });
    const preview = await api.request('/api/procurement/advanced-sla/imports/preview', 'POST', 'manager', { profileId: draft.body.item.id, expectedVersion: 1, csv: scopedCsv });
    assert.equal(preview.status, 201, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.item.impactPreview, { candidateType: 'import', candidateId: preview.body.item.id, candidateVersion: 1, profileId: draft.body.item.id, profileVersion: 1, activePurchaseOrders: 4, matchedPurchaseOrders: 2 });
    const applied = await api.request(`/api/procurement/advanced-sla/imports/${encodeURIComponent(String(preview.body.item.id))}/apply`, 'POST', 'manager', { expectedBatchVersion: 1, expectedProfileVersion: 1 });
    assert.equal(applied.status, 422, JSON.stringify(applied.body));
    assert.equal(applied.body.code, 'ADVANCED_SLA_V2_REQUIRED');
    const after = await api.request('/api/procurement/advanced-sla');
    assert.deepEqual(after.body.impactPreview, root.body.impactPreview, 'rejected legacy apply cannot mutate the persisted draft candidate');
  } finally { await api.close(); store.close(); }
});

test('Advanced SLA upgrades an already-applied old migration 38 without fabricating runtime profile versions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readywork-old-advanced-sla-v38-'));
  const dbPath = join(dir, 'legacy-v38.sqlite');
  const legacyTenant = tenantId;
  const profileId = 'advanced-sla:legacy-published';
  const at = '2026-08-30T02:00:00.000Z';
  try {
    const initial = openPersistence(dbPath, { tenantId: legacyTenant });
    initial.close();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec('PRAGMA foreign_keys = ON');
    legacy.exec('ALTER TABLE procurement_advanced_sla_runtime_controls DROP COLUMN profile_version');
    legacy.exec('ALTER TABLE procurement_advanced_sla_runtime_events DROP COLUMN profile_version');
    legacy.prepare(`INSERT INTO procurement_advanced_sla_profiles
      (tenant_id,id,name,description,status,version,sections_json,auto_send_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
      VALUES (?,?,?,'legacy published policy','published',4,?,?,?,?,?,?,?,?)`).run(
      legacyTenant, profileId, 'Legacy published', JSON.stringify(sections), JSON.stringify({ enabled: false, stages: [], channels: [], risks: [] }),
      manager.humanId, manager.humanId, manager.humanId, at, at, at,
    );
    legacy.prepare(`INSERT INTO procurement_advanced_sla_runtime_controls
      (tenant_id,profile_id,paused,version,updated_by,updated_at) VALUES (?,?,0,3,?,?)`).run(legacyTenant, profileId, manager.humanId, at);
    legacy.prepare(`INSERT INTO procurement_advanced_sla_runtime_events
      (tenant_id,id,profile_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`).run(
      legacyTenant, 'runtime-event:exact', profileId, manager.humanId, 'auto_send_decision', JSON.stringify({ profileId, profileVersion: 4, decisionCode: 'auto_send_disabled' }), at,
    );
    legacy.prepare(`INSERT INTO procurement_advanced_sla_runtime_events
      (tenant_id,id,profile_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`).run(
      legacyTenant, 'runtime-event:unknown', profileId, manager.humanId, 'paused', JSON.stringify({ controlVersion: 2 }), '2026-08-30T02:01:00.000Z',
    );
    legacy.close();

    const restored = openPersistence(dbPath, { tenantId: legacyTenant });
    const api = await startAdvancedSlaApi(restored);
    try {
      const control = restored.db.prepare('SELECT profile_version,paused,version FROM procurement_advanced_sla_runtime_controls WHERE tenant_id=? AND profile_id=?').get(legacyTenant, profileId) as { profile_version: number; paused: number; version: number };
      assert.deepEqual({ ...control }, { profile_version: 4, paused: 0, version: 3 });
      const events = restored.db.prepare('SELECT id,profile_version FROM procurement_advanced_sla_runtime_events WHERE tenant_id=? ORDER BY id').all(legacyTenant) as Array<{ id: string; profile_version: number | null }>;
      assert.deepEqual(events.map((event) => ({ ...event })), [{ id: 'runtime-event:exact', profile_version: 4 }, { id: 'runtime-event:unknown', profile_version: null }]);
      assert.equal(advancedSlaAutoSendDecision(restored.db, legacyTenant, { stage: 'supplier_commitment', channel: 'email', risk: 'high' }).reason, 'advanced_sla_not_published', 'a migrated v1 profile remains readable but cannot drive auto-send');
      const root = await api.request('/api/procurement/advanced-sla');
      assert.equal(root.status, 200);
      assert.equal(normalizeAdvancedSlaDashboard(root.body).state, 'published', 'the repaired runtime binding must remain a valid dashboard root');
      const unknown = (root.body.recentEvents as Array<Record<string, any>>).find((event) => event.action === 'paused');
      assert.deepEqual({ profileVersion: unknown?.detail?.profileVersion, binding: unknown?.detail?.profileVersionBinding }, { profileVersion: null, binding: 'legacy_unknown' });
    } finally {
      await api.close();
      restored.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Advanced SLA runtime controls and audit retain the exact published profile version through replacement and retirement (catches ID-only history)', async () => {
  const store = openPersistence(':memory:', { tenantId });
  const api = await startAdvancedSlaApi(store);
  try {
    const first = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { schemaVersion: 2, name: 'Runtime v2', sections: v2WritableSections(), autoSend: { enabled: false, stages: [], channels: [], risks: [] } });
    const firstPublished = await api.request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(String(first.body.item.id))}/publish`, 'POST', 'manager', { expectedVersion: 1 });
    assert.equal(firstPublished.status, 200, JSON.stringify(firstPublished.body));
    assert.deepEqual({ profileId: firstPublished.body.runtimeControl.profileId, profileVersion: firstPublished.body.runtimeControl.profileVersion, version: firstPublished.body.runtimeControl.version }, { profileId: first.body.item.id, profileVersion: 2, version: 1 });
    const paused = await api.request('/api/procurement/advanced-sla/runtime-control', 'PUT', 'manager', { profileId: first.body.item.id, profileVersion: 2, expectedVersion: 1, paused: true, reason: 'version-bound review' });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.item.profileVersion, 2);
    assert.equal((await api.request('/api/procurement/advanced-sla/runtime-control', 'PUT', 'manager', { profileId: first.body.item.id, profileVersion: 1, expectedVersion: 2, paused: false, reason: 'stale profile version' })).status, 409);

    const replacement = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { schemaVersion: 2, name: 'Runtime replacement', sections: v2WritableSections(), autoSend: { enabled: false, stages: [], channels: [], risks: [] } });
    const replacementPublished = await api.request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(String(replacement.body.item.id))}/publish`, 'POST', 'manager', { expectedVersion: 1 });
    assert.equal(replacementPublished.status, 200, JSON.stringify(replacementPublished.body));
    assert.equal(replacementPublished.body.runtimeControl.profileVersion, 2);
    const retired = await api.request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(String(replacement.body.item.id))}/retire`, 'POST', 'manager', { expectedVersion: 2 });
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    const controls = store.db.prepare('SELECT profile_id,profile_version,version FROM procurement_advanced_sla_runtime_controls WHERE tenant_id=? ORDER BY profile_id').all(tenantId) as Array<{ profile_id: string; profile_version: number; version: number }>;
    assert.deepEqual(controls.map((row) => [row.profile_id, row.profile_version, row.version]), [[first.body.item.id, 2, 2], [replacement.body.item.id, 2, 1]].sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
    const events = store.db.prepare('SELECT profile_id,profile_version,action,detail_json FROM procurement_advanced_sla_runtime_events WHERE tenant_id=? ORDER BY created_at,id').all(tenantId) as Array<{ profile_id: string; profile_version: number; action: string; detail_json: string }>;
    assert.equal(events.every((event) => event.profile_version === 2), true);
    const pauseEvent = events.find((event) => event.action === 'paused')!;
    assert.deepEqual({ profileId: pauseEvent.profile_id, profileVersion: pauseEvent.profile_version, controlVersion: JSON.parse(pauseEvent.detail_json).controlVersion }, { profileId: first.body.item.id, profileVersion: 2, controlVersion: 2 });
  } finally { await api.close(); store.close(); }
});

test('Advanced SLA auto-send risk all is an explicit wildcard for every real candidate risk (catches saved-but-never-matching policies)', async () => {
  const wildcardTenant = 'tenant:advanced-sla-risk-wildcard';
  const store = openPersistence(':memory:', { tenantId: wildcardTenant });
  const api = await startAdvancedSlaApi(store);
  const createdAt = '2026-08-30T02:30:00.000Z';
  try {
    store.db.prepare(`INSERT INTO procurement_sla_policies
      (tenant_id,id,name,description,status,version,rules_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
      VALUES (?,?,?,'','published',1,'[]',?,?,?,?,?,?)`).run(wildcardTenant, 'sla:wildcard', 'Base SLA', manager.humanId, manager.humanId, manager.humanId, createdAt, createdAt, createdAt);
    store.db.prepare(`INSERT INTO procurement_communication_identities
      (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,?,'active',1,?,?,?,?)`).run(wildcardTenant, '王经理', '采购经理', '东方制造', manager.humanId, manager.humanId, createdAt, createdAt);
    store.db.prepare(`INSERT INTO control_credentials
      (tenant_id,id,connector_id,credential_type,name,encrypted_json,status,last_tested_at,last_error,created_at,updated_at)
      VALUES (?,?,?,'smtp','Email','{}','connected',?,NULL,?,?)`).run(wildcardTenant, 'credential:wildcard', 'email', createdAt, createdAt, createdAt);
    const scopedManager = { ...manager, tenantId: wildcardTenant };
    const server = createServer((req, res) => { const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname; void handleProcurementAdvancedSlaRequest(req, res, path, req.method ?? 'GET', { db: store.db, session: scopedManager, now: () => new Date(createdAt) }); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = async (path: string, method: string, body: Record<string, unknown>) => { const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as Record<string, any> }; };
    try {
      const created = await request('/api/procurement/advanced-sla/profiles', 'POST', { schemaVersion: 2, name: 'Wildcard risks', sections: v2WritableSections(), autoSend: { enabled: true, stages: ['supplier_commitment'], channels: ['email'], risks: ['all'] } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const published = await request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(String(created.body.item.id))}/publish`, 'POST', { expectedVersion: 1 });
      assert.equal(published.status, 200, JSON.stringify(published.body));
      for (const risk of ['high', 'medium', 'low'] as const) assert.equal(advancedSlaAutoSendDecision(store.db, wildcardTenant, { stage: 'supplier_commitment', channel: 'email', risk }).reason, 'ready', risk);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  } finally { await api.close(); store.close(); }
});

test('Advanced SLA CSV apply distinguishes first apply, identical replay and conflicting replay', async () => {
  const store = openPersistence(':memory:', { tenantId });
  const api = await startAdvancedSlaApi(store);
  try {
    const created = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { schemaVersion: 2, name: 'Replay target', sections: v2WritableSections(), autoSend: { enabled: false, stages: [], channels: [], risks: [] } });
    const preview = await api.request('/api/procurement/advanced-sla/imports/preview', 'POST', 'manager', { domain: 'logistics_planning', profileId: created.body.item.id, expectedVersion: 1, csv: logisticsPlanningV2Csv() });
    assert.equal(preview.status, 201, JSON.stringify(preview.body));
    const path = `/api/procurement/advanced-sla/imports/${encodeURIComponent(String(preview.body.item.id))}/apply`;
    const fencing = { expectedBatchVersion: 1, expectedProfileVersion: 1, expectedCandidateHash: preview.body.item.candidateHash };
    const first = await api.request(path, 'POST', 'manager', fencing);
    assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.replayed, false);
    const replay = await api.request(path, 'POST', 'manager', fencing);
    assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(replay.body.replayed, true);
    assert.equal((await api.request(path, 'POST', 'manager', { ...fencing, expectedProfileVersion: 2 })).status, 409);
  } finally { await api.close(); store.close(); }
});

test('Advanced SLA persists profile description plus successful and failed v2 CSV provenance in explicit import history', async () => {
  const store = openPersistence(':memory:', { tenantId });
  const api = await startAdvancedSlaApi(store);
  try {
    const created = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { schemaVersion: 2, name: 'Provenance target', description: '覆盖进口清关与收货风险', sections: v2WritableSections(), autoSend: { enabled: false, stages: [], channels: [], risks: [] } });
    assert.equal(created.status, 201, JSON.stringify(created.body)); assert.equal(created.body.item.description, '覆盖进口清关与收货风险');
    const updated = await api.request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(String(created.body.item.id))}`, 'PATCH', 'manager', { schemaVersion: 2, expectedVersion: 1, name: 'Provenance target', description: '已审核的政策意图', sections: v2WritableSections(), autoSend: created.body.item.autoSend });
    assert.equal(updated.status, 200, JSON.stringify(updated.body)); assert.equal(updated.body.item.description, '已审核的政策意图');
    const preview = await api.request('/api/procurement/advanced-sla/imports/preview', 'POST', 'manager', { domain: 'logistics_planning', sourceName: 'approved-rules-2026-08.csv', profileId: created.body.item.id, expectedVersion: 2, csv: logisticsPlanningV2Csv() });
    assert.equal(preview.status, 201, JSON.stringify(preview.body));
    assert.deepEqual({ sourceName: preview.body.item.sourceName, createdBy: preview.body.item.createdBy, error: preview.body.item.error }, { sourceName: 'approved-rules-2026-08.csv', createdBy: manager.humanId, error: null });
    assert.equal(typeof preview.body.item.updatedAt, 'string');
    const applied = await api.request(`/api/procurement/advanced-sla/imports/${encodeURIComponent(String(preview.body.item.id))}/apply`, 'POST', 'manager', { expectedBatchVersion: 1, expectedProfileVersion: 2, expectedCandidateHash: preview.body.item.candidateHash });
    assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.batch.status, 'applied'); assert.equal(applied.body.batch.appliedBy, manager.humanId);

    const failedTarget = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { schemaVersion: 2, name: 'Failed preview target', description: 'retain failure provenance', sections: v2WritableSections(), autoSend: { enabled: false, stages: [], channels: [], risks: [] } });
    const failed = await api.request('/api/procurement/advanced-sla/imports/preview', 'POST', 'manager', { domain: 'logistics_planning', sourceName: 'broken-rules.csv', profileId: failedTarget.body.item.id, expectedVersion: 1, csv: 'schema_version,rule_id\n=SUM(A1),bad' });
    assert.equal(failed.status, 422);
    const root = await api.request('/api/procurement/advanced-sla');
    assert.equal(root.body.profiles.find((item: Record<string, unknown>) => item.id === created.body.item.id).description, '已审核的政策意图');
    const successHistory = root.body.importHistory.find((item: Record<string, unknown>) => item.id === preview.body.item.id);
    assert.deepEqual({ sourceName: successHistory.sourceName, status: successHistory.status, profileVersion: successHistory.profileVersion, createdBy: successHistory.createdBy, appliedBy: successHistory.appliedBy }, { sourceName: 'approved-rules-2026-08.csv', status: 'applied', profileVersion: 2, createdBy: manager.humanId, appliedBy: manager.humanId });
    const failedHistory = root.body.importHistory.find((item: Record<string, unknown>) => item.sourceName === 'broken-rules.csv');
    assert.equal(failedHistory.status, 'failed'); assert.equal(typeof failedHistory.error.message, 'string'); assert.equal(failedHistory.createdBy, manager.humanId);
  } finally { await api.close(); store.close(); }
});

test('Advanced SLA authorization and tenant boundaries localize independently from lifecycle and CSV regressions', async () => {
  const store = openPersistence(':memory:', { tenantId });
  const api = await startAdvancedSlaApi(store);
  try {
    assert.equal((await api.request('/api/procurement/advanced-sla', 'GET', '')).status, 401);
    assert.equal((await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'buyer', { name: 'Forbidden', sections: domainSpecificSections, autoSend: { enabled: false, stages: [], channels: [], risks: [] } })).status, 403);
    const created = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { name: 'Tenant A only', sections: domainSpecificSections, autoSend: { enabled: false, stages: [], channels: [], risks: [] } });
    assert.equal(created.status, 201);
    assert.equal((await api.request('/api/procurement/advanced-sla', 'GET', 'other')).body.profiles.length, 0);
    assert.equal((await api.request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(String(created.body.item.id))}/publish`, 'POST', 'buyer', { expectedVersion: 1 })).status, 403);
  } finally { await api.close(); store.close(); }
});

test('Advanced SLA persists tenant-scoped profiles, runtime controls, imports, and portfolio-derived impact', async () => {
  const store = openPersistence(':memory:', { tenantId });
  const po: PurchaseOrder = { id: 'po:advanced', tenantId, sourceSystem: 'test', externalId: 'PO-ADV-1', status: 'sent', createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z', supplierId: 'supplier:advanced', currency: 'CNY', orderedAt: '2026-08-30T00:00:00.000Z' };
  store.procurement.saveDocument('purchase_order', po);
  const server = createServer((req, res) => {
    const token = String(req.headers.authorization ?? '').replace('Bearer ', '');
    const session = token === 'manager' ? manager : token === 'buyer' ? buyer : token === 'other' ? otherManager : null;
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void handleProcurementAdvancedSlaRequest(req, res, path, req.method ?? 'GET', { db: store.db, session, now: () => new Date('2026-08-30T01:00:00.000Z') })
      .then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error: unknown) => res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path: string, method = 'GET', token = 'buyer', body?: Record<string, unknown>) {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }
  try {
    assert.equal((await request('/api/procurement/advanced-sla', 'GET', '')).status, 401);
    const empty = await request('/api/procurement/advanced-sla');
    assert.equal(empty.status, 200); assert.deepEqual(empty.body.domains.map((item: { id: string }) => item.id), domains);
    assert.equal(empty.body.publishedProfile, null); assert.deepEqual(empty.body.impactPreview, { activePurchaseOrders: 1, matchedPurchaseOrders: 0 });
    assert.equal((await request('/api/procurement/advanced-sla/profiles', 'POST', 'buyer', { name: 'denied', sections })).status, 403);

    const created = await request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { schemaVersion: 2, name: 'Advanced SLA', sections: v2WritableSections(), autoSend: { enabled: true, stages: ['supplier_commitment'], channels: ['email'], risks: ['high'] } });
    assert.equal(created.status, 201, JSON.stringify(created.body)); const id = created.body.item.id as string;
    const updated = await request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(id)}`, 'PATCH', 'manager', { schemaVersion: 2, expectedVersion: 1, name: 'Advanced SLA v2', sections: v2WritableSections(), autoSend: { enabled: true, stages: ['supplier_commitment'], channels: ['email'], risks: ['high'] } });
    assert.equal(updated.status, 200); assert.equal(updated.body.item.version, 2);
    assert.equal((await request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(id)}`, 'PATCH', 'manager', { schemaVersion: 2, expectedVersion: 1, name: 'stale', sections: v2WritableSections(), autoSend: { enabled: true, stages: ['supplier_commitment'], channels: ['email'], risks: ['high'] } })).status, 409);
    const unsafe = await request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(id)}/publish`, 'POST', 'manager', { expectedVersion: 2 });
    assert.equal(unsafe.status, 422, 'missing identity/credential must fail closed');

    store.db.prepare(`INSERT INTO procurement_communication_identities (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,'Readywork','active',1,?,?,?,?)`).run(tenantId, '王经理', '采购经理', manager.humanId, manager.humanId, po.createdAt, po.createdAt);
    store.db.prepare(`INSERT INTO control_credentials (tenant_id,id,connector_id,credential_type,name,encrypted_json,status,last_tested_at,last_error,created_at,updated_at) VALUES (?,?,?,'smtp','Email', '{}','connected',?,NULL,?,?)`).run(tenantId, 'credential:email', 'email', po.createdAt, po.createdAt, po.createdAt);
    store.db.prepare(`INSERT INTO procurement_sla_policies (tenant_id,id,name,description,status,version,rules_json,created_by,updated_by,published_by,created_at,updated_at,published_at) VALUES (?,?,?,'','published',1,'[]',?,?,?, ?,?,?)`).run(tenantId, 'base-sla', 'Base SLA', manager.humanId, manager.humanId, manager.humanId, po.createdAt, po.createdAt, po.createdAt);
    const published = await request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(id)}/publish`, 'POST', 'manager', { expectedVersion: 2 });
    assert.equal(published.status, 200, JSON.stringify(published.body)); assert.equal(published.body.item.status, 'published'); assert.equal(published.body.runtimeControl.paused, false);
    assert.deepEqual(advancedSlaAutoSendDecision(store.db, tenantId, { stage: 'supplier_commitment', channel: 'email', risk: 'high' }), { allowed: true, reason: 'ready', profileId: id, profileVersion: 3, credentialId: 'credential:email' });
    store.db.prepare('UPDATE control_credentials SET last_error=? WHERE tenant_id=? AND id=?').run('mail connector revoked', tenantId, 'credential:email');
    assert.deepEqual(advancedSlaAutoSendDecision(store.db, tenantId, { stage: 'supplier_commitment', channel: 'email', risk: 'high' }), { allowed: false, reason: 'channel_unavailable', profileId: id, profileVersion: 3 }, 'runtime decision rechecks revoked dependencies');
    store.db.prepare('UPDATE control_credentials SET last_error=NULL WHERE tenant_id=? AND id=?').run(tenantId, 'credential:email');
    assert.equal((await request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(id)}`, 'PATCH', 'manager', { schemaVersion: 2, expectedVersion: 3, name: 'immutable', sections: v2WritableSections(), autoSend: { enabled: true, stages: ['supplier_commitment'], channels: ['email'], risks: ['high'] } })).status, 409);
    const paused = await request('/api/procurement/advanced-sla/runtime-control', 'PUT', 'manager', { profileId: id, profileVersion: 3, expectedVersion: 1, paused: true, reason: 'review' });
    assert.equal(paused.status, 200); assert.equal(paused.body.item.paused, true);

    const imported = await request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', { schemaVersion: 2, name: 'Import target', sections: v2WritableSections(), autoSend: { enabled: true, stages: ['supplier_commitment'], channels: ['email'], risks: ['high'] } });
    const targetId = imported.body.item.id as string;
    const preview = await request('/api/procurement/advanced-sla/imports/preview', 'POST', 'manager', { domain: 'logistics_planning', sourceName: 'planning-v2.csv', profileId: targetId, expectedVersion: 1, csv: logisticsPlanningV2Csv() });
    assert.equal(preview.status, 201, JSON.stringify(preview.body)); assert.deepEqual(preview.body.item.summary, { totalRows: 1, validRows: 1, invalidRows: 0, warnings: 0 });
    store.db.prepare("UPDATE procurement_communication_identities SET status='disabled' WHERE tenant_id=?").run(tenantId);
    const applied = await request(`/api/procurement/advanced-sla/imports/${encodeURIComponent(preview.body.item.id as string)}/apply`, 'POST', 'manager', { expectedBatchVersion: 1, expectedProfileVersion: 1, expectedCandidateHash: preview.body.item.candidateHash });
    assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.item.status, 'draft');
    const blockedPublish = await request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(targetId)}/publish`, 'POST', 'manager', { expectedVersion: 2 });
    assert.equal(blockedPublish.status, 422, 'publication rechecks revoked auto-send dependencies');
    store.db.prepare("UPDATE procurement_communication_identities SET status='active' WHERE tenant_id=?").run(tenantId);
    const importedPublished = await request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(targetId)}/publish`, 'POST', 'manager', { expectedVersion: 2 });
    assert.equal(importedPublished.status, 200, JSON.stringify(importedPublished.body)); assert.equal(importedPublished.body.item.status, 'published');
    assert.equal((store.db.prepare('SELECT status FROM procurement_advanced_sla_profiles WHERE tenant_id=? AND id=?').get(tenantId, id) as { status: string }).status, 'retired', 'publishing a replacement retires the previous profile');
    assert.equal((await request(`/api/procurement/advanced-sla/imports/${encodeURIComponent(preview.body.item.id as string)}/apply`, 'POST', 'manager', { expectedBatchVersion: 1, expectedProfileVersion: 1, expectedCandidateHash: preview.body.item.candidateHash })).status, 409, 'an applied batch cannot mutate a now-published target');
    const retired = await request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(targetId)}/retire`, 'POST', 'manager', { expectedVersion: 3 });
    assert.equal(retired.status, 200); assert.equal(retired.body.item.status, 'retired');
    assert.equal((await request('/api/procurement/advanced-sla', 'GET', 'other')).body.profiles.length, 0, 'tenant isolation');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_advanced_sla_profile_events WHERE tenant_id=?').get(tenantId) as { count: number }).count > 0, true);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_advanced_sla_runtime_events WHERE tenant_id=?').get(tenantId) as { count: number }).count > 0, true);
    assert.equal((await request('/api/procurement/advanced-sla')).body.recentEvents.length > 0, true, 'second read sees durable events');
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); store.close(); }
});

test('Advanced SLA auto-send safety matrix rejects each revoked persisted fact (catches dashboard-readiness bypasses)', () => {
  const matrixTenant = 'tenant:advanced-sla-matrix';
  const store = openPersistence(':memory:', { tenantId: matrixTenant });
  const createdAt = '2026-08-30T02:00:00.000Z';
  const candidate = { stage: 'supplier_commitment' as const, channel: 'email' as const, risk: 'high' as const };
  const decide = () => advancedSlaAutoSendDecision(store.db, matrixTenant, candidate);
  try {
    assert.deepEqual(decide(), { allowed: false, reason: 'advanced_sla_not_published' }, 'a missing published profile must fail closed');
    store.db.prepare(`INSERT INTO procurement_advanced_sla_profiles
      (tenant_id,id,name,status,version,sections_json,auto_send_json,created_by,updated_by,published_by,created_at,updated_at,published_at,schema_version)
      VALUES (?,?,?,'published',7,?,?,?,?,?,?,?,?,2)`).run(
      matrixTenant, 'advanced-sla:matrix', 'Safety matrix', JSON.stringify(v2Sections()), JSON.stringify({ enabled: true, stages: ['supplier_commitment'], channels: ['email'], risks: ['high'] }),
      manager.humanId, manager.humanId, manager.humanId, createdAt, createdAt, createdAt,
    );
    store.db.prepare(`INSERT INTO procurement_advanced_sla_runtime_controls
      (tenant_id,profile_id,profile_version,paused,version,updated_by,updated_at) VALUES (?,?,7,0,1,?,?)`)
      .run(matrixTenant, 'advanced-sla:matrix', manager.humanId, createdAt);
    store.db.prepare(`INSERT INTO procurement_communication_identities
      (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,'东方制造','active',1,?,?,?,?)`)
      .run(matrixTenant, '李娜', '采购经理', manager.humanId, manager.humanId, createdAt, createdAt);
    store.db.prepare(`INSERT INTO control_credentials
      (tenant_id,id,connector_id,credential_type,name,encrypted_json,status,last_tested_at,last_error,created_at,updated_at)
      VALUES (?,?,?,'smtp','Email','{}','connected',?,NULL,?,?)`)
      .run(matrixTenant, 'credential:matrix-email', 'email', createdAt, createdAt, createdAt);
    store.db.prepare(`INSERT INTO procurement_sla_policies
      (tenant_id,id,name,description,status,version,rules_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
      VALUES (?,?,?,'','published',1,'[]',?,?,?,?,?,?)`)
      .run(matrixTenant, 'sla:matrix', 'Base SLA', manager.humanId, manager.humanId, manager.humanId, createdAt, createdAt, createdAt);

    assert.deepEqual(decide(), { allowed: true, reason: 'ready', profileId: 'advanced-sla:matrix', profileVersion: 7, credentialId: 'credential:matrix-email' });
    store.db.prepare('UPDATE procurement_advanced_sla_runtime_controls SET paused=1 WHERE tenant_id=?').run(matrixTenant);
    assert.equal(decide().reason, 'kill_switch_paused');
    store.db.prepare('UPDATE procurement_advanced_sla_runtime_controls SET paused=0 WHERE tenant_id=?').run(matrixTenant);
    store.db.prepare('UPDATE procurement_advanced_sla_profiles SET auto_send_json=? WHERE tenant_id=?').run(JSON.stringify({ enabled: false, stages: [], channels: [], risks: [] }), matrixTenant);
    assert.equal(decide().reason, 'auto_send_disabled');
    store.db.prepare('UPDATE procurement_advanced_sla_profiles SET auto_send_json=? WHERE tenant_id=?').run(JSON.stringify({ enabled: true, stages: ['po_sent'], channels: ['email'], risks: ['high'] }), matrixTenant);
    assert.equal(decide().reason, 'stage_not_allowed');
    store.db.prepare('UPDATE procurement_advanced_sla_profiles SET auto_send_json=? WHERE tenant_id=?').run(JSON.stringify({ enabled: true, stages: ['supplier_commitment'], channels: ['whatsapp'], risks: ['high'] }), matrixTenant);
    assert.equal(decide().reason, 'channel_not_allowed');
    store.db.prepare('UPDATE procurement_advanced_sla_profiles SET auto_send_json=? WHERE tenant_id=?').run(JSON.stringify({ enabled: true, stages: ['supplier_commitment'], channels: ['email'], risks: ['low'] }), matrixTenant);
    assert.equal(decide().reason, 'risk_not_allowed');
    store.db.prepare('UPDATE procurement_advanced_sla_profiles SET auto_send_json=? WHERE tenant_id=?').run(JSON.stringify({ enabled: true, stages: ['supplier_commitment'], channels: ['email'], risks: ['high'] }), matrixTenant);
    store.db.prepare("UPDATE procurement_communication_identities SET status='disabled' WHERE tenant_id=?").run(matrixTenant);
    assert.equal(decide().reason, 'communication_identity_missing');
    store.db.prepare("UPDATE procurement_communication_identities SET status='active' WHERE tenant_id=?").run(matrixTenant);
    store.db.prepare('UPDATE control_credentials SET last_error=? WHERE tenant_id=?').run('revoked', matrixTenant);
    assert.equal(decide().reason, 'channel_unavailable');
  } finally { store.close(); }
});

test('Advanced SLA v2 exposes one strict, metadata-rich, flat CSV template per domain', async () => {
  const store = openPersistence(':memory:', { tenantId });
  const api = await startAdvancedSlaApi(store, '2026-09-03T04:00:00.000Z');
  try {
    for (const domain of ADVANCED_SLA_V2_DOMAINS) {
      const response = await api.requestRaw(`/api/procurement/advanced-sla/templates/${domain}`);
      assert.equal(response.status, 200, `${domain}: ${response.text}`);
      assert.match(response.contentType ?? '', /^text\/csv/);
      assert.match(response.text, /^# Readywork Advanced SLA v2 template/m);
      assert.match(response.text, /^# schema_version=2$/m);
      assert.match(response.text, new RegExp(`^# domain=${domain}$`, 'm'));
      assert.match(response.text, /^# formats=/m);
      assert.match(response.text, /^# enums=/m);
      const header = response.text.trim().split('\n').at(-1)!;
      assert.deepEqual(header.split(','), advancedSlaV2CsvColumns(domain));
      assert.doesNotMatch(header, /scope_json|parameters_json|created_by|approved_by|last_updated/);
    }
  } finally { await api.close(); store.close(); }
});

test('Advanced SLA v2 JSON writes preserve editable reference metadata while audit identity stays session-owned, keep v1 read-only, and require v2 before publish', async () => {
  const store = openPersistence(':memory:', { tenantId });
  const api = await startAdvancedSlaApi(store, '2026-09-03T04:00:00.000Z');
  try {
    const created = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', {
      schemaVersion: 2, name: 'Advanced SLA v2', description: 'Typed nine-domain policy', sections: v2WritableSections(),
      autoSend: { enabled: false, stages: [], channels: [], risks: [] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.item.schemaVersion, 2);
    assert.equal(created.body.item.sections[0].rules[0].createdBy, manager.humanId);
    assert.equal(created.body.item.sections[0].rules[0].approvedBy, null);
    assert.equal(created.body.item.sections[0].rules[0].lastUpdated, '2026-09-03T04:00:00.000Z');
    const stored = store.db.prepare('SELECT schema_version FROM procurement_advanced_sla_profiles WHERE tenant_id=? AND id=?').get(tenantId, created.body.item.id) as { schema_version: number };
    assert.equal(stored.schema_version, 2);

    const forged = v2WritableSections();
    (forged[0]!.rules as Array<Record<string, unknown>>)[0]!['createdBy'] = 'attacker';
    (forged[0]!.rules as Array<Record<string, unknown>>)[0]!['approvedBy'] = 'human:approver';
    (forged[0]!.rules as Array<Record<string, unknown>>)[0]!['lastUpdated'] = '2026-09-02T00:00:00.000Z';
    const edited = await api.request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(created.body.item.id)}`, 'PATCH', 'manager', {
      schemaVersion: 2, expectedVersion: 1, name: 'Reference metadata edit', sections: forged, autoSend: created.body.item.autoSend,
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.item.sections[0].rules[0].createdBy, 'attacker');
    assert.equal(edited.body.item.sections[0].rules[0].approvedBy, 'human:approver');
    assert.equal(edited.body.item.sections[0].rules[0].lastUpdated, '2026-09-02T00:00:00.000Z');
    const root = await api.request('/api/procurement/advanced-sla');
    const updatedEvent = root.body.recentEvents.find((event: Record<string, unknown>) => event.action === 'draft_updated');
    assert.equal(updatedEvent.actor_id, manager.humanId);

    const legacy = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', {
      name: 'Legacy v1', sections: domainSpecificSections, autoSend: { enabled: false, stages: [], channels: [], risks: [] },
    });
    assert.equal(legacy.status, 201);
    assert.equal(legacy.body.item.schemaVersion, 1);
    assert.equal(legacy.body.item.upgradePreview.ready, false);
    assert.ok(legacy.body.item.upgradePreview.validationResults.some((item: Record<string, unknown>) => item.field === 'companyCode'));
    const publishLegacy = await api.request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(legacy.body.item.id)}/publish`, 'POST', 'manager', { expectedVersion: 1 });
    assert.equal(publishLegacy.status, 422);
    assert.equal(publishLegacy.body.code, 'ADVANCED_SLA_V2_REQUIRED');
  } finally { await api.close(); store.close(); }
});

test('Advanced SLA v2 CSV persists row validation and applies only valid rows with batch/profile/candidate fencing', async () => {
  const store = openPersistence(':memory:', { tenantId });
  const api = await startAdvancedSlaApi(store, '2026-09-03T04:00:00.000Z');
  const domain = 'logistics_planning' as const;
  try {
    const created = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', {
      schemaVersion: 2, name: 'CSV v2 target', sections: v2WritableSections(), autoSend: { enabled: false, stages: [], channels: [], risks: [] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const columns = advancedSlaV2CsvColumns(domain);
    const valid: Record<string, string> = {
      schema_version: '2', rule_id: 'csv-valid', name: 'Valid logistics plan', domain, company_code: 'RW-CN', business_unit: 'Procurement',
      stage: 'supplier_commitment', route: 'import', risk: 'all', channel: 'email', effective_from: '2026-09-04', effective_to: '', priority: '100',
      status: 'active', notes: 'Validated import', planning_activity: 'Reserve vessel capacity', booking_lead_time_hours: '96', capacity_requirement: '40HQ x 1',
      planning_evidence: 'Carrier confirmation', responsible_function: 'Logistics', transport_mode: 'ocean', incoterm: 'FOB', origin_country: 'CN',
      destination_country: 'DE', carrier_confirmation_hours: '12',
    };
    const invalid: Record<string, string> = { ...valid, rule_id: 'csv-invalid', priority: '1001' };
    const csvV2 = [columns.join(','), ...[valid, invalid].map((row) => columns.map((column) => csvCell(row[column] ?? '')).join(','))].join('\n');
    const preview = await api.request('/api/procurement/advanced-sla/imports/preview', 'POST', 'manager', {
      domain, sourceName: 'logistics-v2.csv', profileId: created.body.item.id, expectedVersion: 1, csv: csvV2,
    });
    assert.equal(preview.status, 201, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.item.summary, { totalRows: 2, validRows: 1, invalidRows: 1, warnings: 0 });
    assert.equal(preview.body.item.schemaVersion, 2);
    assert.equal(preview.body.item.domain, domain);
    assert.match(preview.body.item.sourceSha256, /^[0-9a-f]{64}$/);
    assert.match(preview.body.item.candidateHash, /^[0-9a-f]{64}$/);
    assert.ok(preview.body.item.validationResults.some((item: Record<string, unknown>) => item.rowNumber === 3 && item.field === 'priority' && item.severity === 'error'));

    const persisted = store.db.prepare(`SELECT schema_version,domain,total_count,valid_count,invalid_count,warning_count,candidate_hash,validation_results_json
      FROM procurement_advanced_sla_import_batches WHERE tenant_id=? AND id=?`).get(tenantId, preview.body.item.id) as Record<string, unknown>;
    assert.deepEqual({ schemaVersion: persisted['schema_version'], domain: persisted['domain'], total: persisted['total_count'], valid: persisted['valid_count'], invalid: persisted['invalid_count'], warning: persisted['warning_count'] }, { schemaVersion: 2, domain, total: 2, valid: 1, invalid: 1, warning: 0 });

    const wrongHash = await api.request(`/api/procurement/advanced-sla/imports/${encodeURIComponent(preview.body.item.id)}/apply`, 'POST', 'manager', {
      expectedBatchVersion: 1, expectedProfileVersion: 1, expectedCandidateHash: '0'.repeat(64),
    });
    assert.equal(wrongHash.status, 409);
    const applied = await api.request(`/api/procurement/advanced-sla/imports/${encodeURIComponent(preview.body.item.id)}/apply`, 'POST', 'manager', {
      expectedBatchVersion: 1, expectedProfileVersion: 1, expectedCandidateHash: preview.body.item.candidateHash,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.item.status, 'draft');
    assert.equal(applied.body.item.version, 2);
    assert.equal(applied.body.batch.status, 'applied');
    assert.equal(applied.body.batch.version, 2);
    const imported = applied.body.item.sections.find((section: Record<string, unknown>) => section.domain === domain).rules;
    assert.ok(imported.some((item: Record<string, unknown>) => item.ruleId === 'csv-valid'));
    assert.equal(imported.some((item: Record<string, unknown>) => item.ruleId === 'csv-invalid'), false);
    const root = await api.request('/api/procurement/advanced-sla');
    const appliedEvent = root.body.recentEvents.find((event: Record<string, any>) => event.action === 'import_applied_to_draft');
    assert.deepEqual({ schemaVersion: appliedEvent.detail.schemaVersion, status: appliedEvent.detail.status, ruleCount: appliedEvent.detail.ruleCount, source: appliedEvent.detail.source }, { schemaVersion: 2, status: 'draft', ruleCount: 9, source: 'csv' });
    assert.equal(typeof appliedEvent.detail.diffSummary, 'object');
  } finally { await api.close(); store.close(); }
});

test('Advanced SLA v2 survives a real SQLite close-reopen create-edit-template-preview-apply-read flow without external side effects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'readywork-advanced-sla-v2-'));
  const dbPath = join(dir, 'isolated.sqlite');
  let store = openPersistence(dbPath, { tenantId });
  let api = await startAdvancedSlaApi(store, '2026-09-03T05:00:00.000Z');
  try {
    const created = await api.request('/api/procurement/advanced-sla/profiles', 'POST', 'manager', {
      schemaVersion: 2, name: 'Durable v2 policy', description: 'isolated persistence proof', sections: v2WritableSections(),
      autoSend: { enabled: false, stages: [], channels: [], risks: [] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const editedSections = v2WritableSections();
    const firstRule = (editedSections[0]!.rules as Array<Record<string, unknown>>)[0]!;
    firstRule.name = 'Persisted typed rule edit';
    const edited = await api.request(`/api/procurement/advanced-sla/profiles/${encodeURIComponent(created.body.item.id)}`, 'PATCH', 'manager', {
      schemaVersion: 2, expectedVersion: 1, name: 'Durable v2 policy', description: 'edited before import', sections: editedSections,
      autoSend: { enabled: false, stages: [], channels: [], risks: [] },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.item.sections[0].rules[0].name, 'Persisted typed rule edit');
    const template = await api.requestRaw('/api/procurement/advanced-sla/templates/logistics_planning');
    assert.equal(template.status, 200); assert.match(template.text, /^# schema_version=2$/m);
    const preview = await api.request('/api/procurement/advanced-sla/imports/preview', 'POST', 'manager', {
      domain: 'logistics_planning', sourceName: 'durable-planning.csv', profileId: created.body.item.id, expectedVersion: 2, csv: logisticsPlanningV2Csv('durable-csv-rule'),
    });
    assert.equal(preview.status, 201, JSON.stringify(preview.body));
    const applied = await api.request(`/api/procurement/advanced-sla/imports/${encodeURIComponent(preview.body.item.id)}/apply`, 'POST', 'manager', {
      expectedBatchVersion: 1, expectedProfileVersion: 2, expectedCandidateHash: preview.body.item.candidateHash,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.deepEqual({ status: applied.body.item.status, version: applied.body.item.version }, { status: 'draft', version: 3 });
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_outbox WHERE tenant_id=?').get(tenantId) as { count: number }).count, 0);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_advanced_sla_runtime_controls WHERE tenant_id=?').get(tenantId) as { count: number }).count, 0);

    await api.close(); store.close();
    store = openPersistence(dbPath, { tenantId });
    api = await startAdvancedSlaApi(store, '2026-09-03T05:01:00.000Z');
    const reloaded = await api.request('/api/procurement/advanced-sla');
    const durableDraft = reloaded.body.draftProfiles.find((item: Record<string, unknown>) => item.id === created.body.item.id);
    assert.deepEqual({ schemaVersion: durableDraft.schemaVersion, status: durableDraft.status, version: durableDraft.version, description: durableDraft.description }, { schemaVersion: 2, status: 'draft', version: 3, description: 'edited before import' });
    const logistics = durableDraft.sections.find((section: Record<string, unknown>) => section.domain === 'logistics_planning');
    assert.equal(logistics.rules[0].ruleId, 'durable-csv-rule');
    assert.equal(reloaded.body.importHistory.find((item: Record<string, unknown>) => item.id === preview.body.item.id).status, 'applied');
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_advanced_sla_profiles WHERE tenant_id=?').get(tenantId) as { count: number }).count, 1);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_advanced_sla_import_batches WHERE tenant_id=?').get(tenantId) as { count: number }).count, 1);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM procurement_advanced_sla_profile_events WHERE tenant_id=?').get(tenantId) as { count: number }).count, 3);
  } finally {
    await api.close().catch(() => undefined);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
