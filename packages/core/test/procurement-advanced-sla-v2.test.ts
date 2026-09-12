import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADVANCED_SLA_DOMAINS,
  advancedSlaV2CsvColumns,
  normalizeAdvancedSlaV2Sections,
  type AdvancedSlaDomain,
  type AdvancedSlaRuleV2,
  type AdvancedSlaRuleV2Parameters,
  type AdvancedSlaSectionV2,
} from '../src/procurement-advanced-sla.js';

const parameters: Record<AdvancedSlaDomain, AdvancedSlaRuleV2Parameters> = {
  production_service_milestones: {
    domain: 'production_service_milestones', supplierScope: 'Approved suppliers', itemOrService: 'Hydraulic valve', milestoneSequence: 1,
    blockingRuleIds: [], standardDurationHours: 48, updateCadenceHours: 8, startEvidence: 'Acknowledged plan', completionEvidence: 'Inspection record',
    supplierContactRole: 'Production planner', calendarMode: 'tenant_business_days', toleranceHours: 4,
  },
  communication_escalation: {
    domain: 'communication_escalation', eventType: 'supplier_confirmation_overdue', firstResponseHours: 4, firstReminderHours: 8,
    secondReminderHours: 16, managerEscalationHours: 24, escalationChannels: ['email'], supplierLevel1Role: 'Planner', supplierLevel2Role: 'Manager',
    supplierLevel3Role: 'Director', firstReminderRisk: 'low', secondReminderRisk: 'medium', managerEscalationRisk: 'high',
    messageTemplateId: 'template:confirmation', internalOwnerRole: 'Buyer', quietHoursPolicy: 'Tenant working hours',
  },
  payment_terms: {
    domain: 'payment_terms', paymentTerm: 'Net 30', triggerEvent: 'Accepted GRN', preparationHours: 24, completionSlaHours: 72,
    blockingStage: 'delivery_grn', requiredDocuments: ['Invoice'], responsibleFunction: 'Accounts payable', lcRequired: true,
    lcDetails: 'Irrevocable letter of credit', currency: 'USD', amountThreshold: 10000,
  },
  logistics_planning: {
    domain: 'logistics_planning', planningActivity: 'Book capacity', bookingLeadTimeHours: 72, capacityRequirement: '20GP x 1',
    planningEvidence: 'Carrier booking', responsibleFunction: 'Logistics', transportMode: 'ocean', incoterm: 'FOB', originCountry: 'CN',
    destinationCountry: 'DE', carrierConfirmationHours: 12,
  },
  logistics_handover: {
    domain: 'logistics_handover', handoverRequirement: 'Verify sealed cartons', requiredEvidence: ['Packing list'], documentTemplates: ['handover-v2'],
    handoverSlaHours: 12, responsibleFunction: 'Warehouse', handoverLocation: 'Supplier dock', custodyFromRole: 'Supplier', custodyToRole: 'Carrier', sealRequired: true,
  },
  transit_monitoring: {
    domain: 'transit_monitoring', transitMilestone: 'Arrival at destination port', updateCadenceHours: 24, exceptionTemplate: 'Transit exception',
    escalationTemplate: 'Transit escalation', trackingEvidence: 'Carrier event', responsibleFunction: 'Logistics', transportMode: 'ocean',
    etaToleranceHours: 12, missedUpdateRisk: 'medium', carrierRole: 'Forwarder',
  },
  regulatory_import_approval: {
    domain: 'regulatory_import_approval', approvalName: 'Import permit', authority: 'Customs authority', dependencyRuleIds: [],
    preparationHours: 48, approvalSlaHours: 120, requiredDocuments: ['Permit application'], approvalEvidence: 'Approved permit',
    responsibleFunction: 'Trade compliance', jurisdictionCountry: 'DE', permitType: 'Import licence', expiryWarningDays: 30,
  },
  customs_clearance: {
    domain: 'customs_clearance', clearanceMilestone: 'Customs declaration', requiredDocuments: ['Commercial invoice'], blockingRuleIds: [],
    clearanceSlaHours: 24, escalationTemplate: 'Broker escalation', clearanceEvidence: 'Customs release', responsibleFunction: 'Trade compliance',
    customsRegime: 'Free circulation', brokerRole: 'Customs broker', dutyPaymentSlaHours: 8, demurrageRiskHours: 48,
  },
  quality_inspection_grn: {
    domain: 'quality_inspection_grn', inspectionType: 'Inbound inspection', inspectionSlaHours: 24, grnSlaHours: 8,
    requiredEvidence: ['Inspection report'], qualityOwnerRole: 'Quality engineer', grnOwnerRole: 'Warehouse clerk',
    rejectionEscalationRole: 'Quality manager', acceptanceCriteria: 'Zero critical defects', samplingPlan: 'ISO 2859-1', defectTolerance: 1.5,
    reinspectionSlaHours: 12, grnBlockingRuleIds: [],
  },
};

function rule(domain: AdvancedSlaDomain, index: number, overrides: Partial<AdvancedSlaRuleV2> = {}): AdvancedSlaRuleV2 {
  return {
    schemaVersion: 2,
    ruleId: `rule-${index}`,
    name: `${domain} rule`,
    domain,
    companyCode: 'RW-CN',
    businessUnit: 'Procurement',
    stage: 'supplier_commitment',
    route: 'import',
    risk: 'all',
    channel: 'email',
    effectiveFrom: '2026-09-03',
    effectiveTo: null,
    priority: index,
    status: 'draft',
    createdBy: 'human:manager',
    approvedBy: null,
    lastUpdated: '2026-09-03T04:00:00.000Z',
    notes: null,
    parameters: structuredClone(parameters[domain]),
    ...overrides,
  } as AdvancedSlaRuleV2;
}

function sections(): AdvancedSlaSectionV2[] {
  return ADVANCED_SLA_DOMAINS.map((domain, index) => ({ domain, enabled: true, rules: [rule(domain, index + 1)] }));
}

test('Advanced SLA v2 preserves the exact nine-domain discriminated contract and exposes flat per-domain CSV columns', () => {
  const input = sections();
  assert.deepEqual(normalizeAdvancedSlaV2Sections(input), input);
  assert.deepEqual(input.map((section) => section.domain), ADVANCED_SLA_DOMAINS);

  const referenceColumns: Record<AdvancedSlaDomain, readonly string[]> = {
    production_service_milestones: ['supplier_code', 'milestone_name'],
    communication_escalation: ['event_type', 'initial_response_sla'],
    payment_terms: ['payment_term', 'lc_type'],
    logistics_planning: ['incoterm', 'freight_booking_owner'],
    logistics_handover: ['document_information_name', 'mandatory'],
    transit_monitoring: ['standard_transit_time', 'required_transit_events'],
    regulatory_import_approval: ['approval_document_name', 'regulatory_authority'],
    customs_clearance: ['destination_country', 'clearance_sla'],
    quality_inspection_grn: ['inspection_type', 'quality_failure_action'],
  };

  for (const domain of ADVANCED_SLA_DOMAINS) {
    const columns = advancedSlaV2CsvColumns(domain);
    assert.deepEqual(columns.slice(0, 4), ['schema_version', 'rule_id', 'name', 'domain']);
    assert.ok(columns.includes('company_code'));
    assert.ok(columns.includes('effective_from'));
    assert.ok(columns.includes('priority'));
    assert.ok(columns.includes('notes'));
    for (const column of referenceColumns[domain]) assert.ok(columns.includes(column), `${domain}: ${column}`);
    assert.equal(columns.includes('created_by'), false);
    assert.equal(columns.includes('approved_by'), false);
    assert.equal(columns.includes('last_updated'), false);
    assert.equal(columns.includes('scope_json'), false);
    assert.equal(columns.includes('parameters_json'), false);
    assert.equal(new Set(columns).size, columns.length);
  }
});

test('Advanced SLA v2 rejects unknown and cross-domain fields, invalid dates and priorities, and equal-priority overlapping scopes', () => {
  const crossDomain = sections() as unknown as Array<Record<string, unknown>>;
  (crossDomain[0]!['rules'] as Array<Record<string, unknown>>)[0]!['domain'] = 'communication_escalation';
  assert.throws(() => normalizeAdvancedSlaV2Sections(crossDomain), /domain/i);

  const unknown = sections() as unknown as Array<Record<string, unknown>>;
  ((unknown[0]!['rules'] as Array<Record<string, unknown>>)[0]!['parameters'] as Record<string, unknown>)['invented'] = true;
  assert.throws(() => normalizeAdvancedSlaV2Sections(unknown), /unrecognized|unknown|invented/i);

  for (const [field, value, pattern] of [
    ['priority', 1001, /priority/i],
    ['effectiveFrom', '2026-02-30', /effectiveFrom|date/i],
    ['lastUpdated', '2026-09-03T04:00:00+08:00', /lastUpdated|UTC/i],
  ] as const) {
    const invalid = sections();
    Object.assign(invalid[0]!.rules[0]!, { [field]: value });
    assert.throws(() => normalizeAdvancedSlaV2Sections(invalid), pattern);
  }

  const reversed = sections();
  reversed[0]!.rules[0]!.effectiveTo = '2026-09-02';
  assert.throws(() => normalizeAdvancedSlaV2Sections(reversed), /effectiveTo/i);

  const overlap = sections();
  overlap[0]!.rules.push(rule('production_service_milestones', 1, { ruleId: 'overlap', effectiveFrom: '2026-09-04', effectiveTo: '2026-09-30' }));
  assert.throws(() => normalizeAdvancedSlaV2Sections(overlap), /overlap|重叠/i);
});

test('Advanced SLA v2 rejects missing, self and cyclic dependencies across the complete profile graph', () => {
  const dangling = sections();
  dangling[0]!.rules[0]!.parameters = { ...dangling[0]!.rules[0]!.parameters, blockingRuleIds: ['missing'] } as never;
  assert.throws(() => normalizeAdvancedSlaV2Sections(dangling), /missing|不存在/i);

  const self = sections();
  self[0]!.rules[0]!.parameters = { ...self[0]!.rules[0]!.parameters, blockingRuleIds: ['rule-1'] } as never;
  assert.throws(() => normalizeAdvancedSlaV2Sections(self), /self|自身/i);

  const cyclic = sections();
  cyclic[0]!.rules[0]!.parameters = { ...cyclic[0]!.rules[0]!.parameters, blockingRuleIds: ['rule-7'] } as never;
  cyclic[6]!.rules[0]!.parameters = { ...cyclic[6]!.rules[0]!.parameters, dependencyRuleIds: ['rule-1'] } as never;
  assert.throws(() => normalizeAdvancedSlaV2Sections(cyclic), /cycle|循环/i);
});
