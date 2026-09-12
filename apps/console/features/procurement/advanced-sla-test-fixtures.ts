import type { AdvancedSlaSectionV2 } from "@readywork/advanced-sla-contract";

export const literalNineDomainSections = [
  { domain: "production_service_milestones", enabled: true, rules: [{ id: "rule-1", name: "Milestone", enabled: true, scope: { stage: "supplier_commitment", route: "import", risk: "high", channel: "email" }, parameters: { domain: "production_service_milestones", supplierScope: "Supplier A", itemOrService: "Valve", milestoneSequence: 1, blockingRuleIds: [], standardDurationHours: 48, updateCadenceHours: 12, startEvidence: "work order", completionEvidence: "inspection", supplierContactRole: "planner" } }] },
  { domain: "communication_escalation", enabled: true, rules: [{ id: "rule-2", name: "Escalation", enabled: true, scope: { stage: "supplier_commitment", route: "all", risk: "all", channel: "email" }, parameters: { domain: "communication_escalation", eventType: "overdue", firstResponseHours: 4, firstReminderHours: 8, secondReminderHours: 16, managerEscalationHours: 24, escalationChannels: ["email", "whatsapp"], supplierLevel1Role: "coordinator", supplierLevel2Role: "manager", supplierLevel3Role: "director", firstReminderRisk: "low", secondReminderRisk: "medium", managerEscalationRisk: "high" } }] },
  { domain: "payment_terms", enabled: true, rules: [{ id: "rule-3", name: "Payment", enabled: true, scope: { stage: "delivery_grn", route: "all", risk: "all", channel: "email" }, parameters: { domain: "payment_terms", paymentTerm: "Net 30", triggerEvent: "GRN", preparationHours: 24, completionSlaHours: 72, blockingStage: "delivery_grn", requiredDocuments: ["invoice", "GRN"], responsibleFunction: "AP", lcRequired: true, lcDetails: "Sight LC" } }] },
  { domain: "logistics_planning", enabled: true, rules: [{ id: "rule-4", name: "Planning", enabled: true, scope: { stage: "fulfilment_production", route: "import", risk: "all", channel: "email" }, parameters: { domain: "logistics_planning", planningActivity: "book capacity", bookingLeadTimeHours: 72, capacityRequirement: "20GP", planningEvidence: "booking", responsibleFunction: "logistics" } }] },
  { domain: "logistics_handover", enabled: true, rules: [{ id: "rule-5", name: "Handover", enabled: true, scope: { stage: "dispatch_transit", route: "all", risk: "all", channel: "email" }, parameters: { domain: "logistics_handover", handoverRequirement: "sealed handover", requiredEvidence: ["packing list"], documentTemplates: ["handover-v2"], handoverSlaHours: 12, responsibleFunction: "warehouse" } }] },
  { domain: "transit_monitoring", enabled: true, rules: [{ id: "rule-6", name: "Transit", enabled: true, scope: { stage: "dispatch_transit", route: "all", risk: "all", channel: "email" }, parameters: { domain: "transit_monitoring", transitMilestone: "destination port", updateCadenceHours: 24, exceptionTemplate: "exception-v1", escalationTemplate: "escalation-v1", trackingEvidence: "carrier event", responsibleFunction: "control tower" } }] },
  { domain: "regulatory_import_approval", enabled: true, rules: [{ id: "rule-7", name: "Approval", enabled: true, scope: { stage: "fulfilment_production", route: "import", risk: "all", channel: "email" }, parameters: { domain: "regulatory_import_approval", approvalName: "import permit", authority: "customs", dependencyRuleIds: [], preparationHours: 48, approvalSlaHours: 120, requiredDocuments: ["permit"], approvalEvidence: "approval number", responsibleFunction: "compliance" } }] },
  { domain: "customs_clearance", enabled: true, rules: [{ id: "rule-8", name: "Customs", enabled: true, scope: { stage: "dispatch_transit", route: "import", risk: "all", channel: "email" }, parameters: { domain: "customs_clearance", clearanceMilestone: "declaration", requiredDocuments: ["invoice", "packing list"], blockingRuleIds: ["rule-7"], clearanceSlaHours: 48, escalationTemplate: "customs-escalation", clearanceEvidence: "release note", responsibleFunction: "customs" } }] },
  { domain: "quality_inspection_grn", enabled: true, rules: [{ id: "rule-9", name: "Quality", enabled: true, scope: { stage: "delivery_grn", route: "all", risk: "all", channel: "email" }, parameters: { domain: "quality_inspection_grn", inspectionType: "full", inspectionSlaHours: 24, grnSlaHours: 8, requiredEvidence: ["inspection report"], qualityOwnerRole: "quality manager", grnOwnerRole: "warehouse manager", rejectionEscalationRole: "procurement director", acceptanceCriteria: "AQL 1.0" } }] },
] as const;

export const literalNineDomainDraft = {
  id: "draft-nine",
  name: "Nine domains",
  description: "Nine-domain operational policy",
  status: "draft",
  version: 4,
  schemaVersion: 1,
  sections: literalNineDomainSections,
  autoSend: { enabled: false, stages: [], channels: [], risks: [] },
  upgradePreview: { fromSchemaVersion: 1, toSchemaVersion: 2, ready: false, validationResults: [{ rowNumber: 0, normalizedRuleId: "rule-1", severity: "error", field: "companyCode", code: "V1_UPGRADE_REQUIRED", message: "companyCode is required" }] },
} as const;

export const literalNineDomainV2Sections = literalNineDomainSections.map((section, index) => ({
  domain: section.domain,
  enabled: section.enabled,
  rules: section.rules.map((rule) => ({
    schemaVersion: 2 as const,
    ruleId: rule.id,
    name: rule.name,
    domain: section.domain,
    companyCode: "RW-CN",
    businessUnit: "Procurement",
    stage: rule.scope.stage,
    route: rule.scope.route,
    risk: rule.scope.risk,
    channel: rule.scope.channel,
    effectiveFrom: "2026-09-03",
    effectiveTo: null,
    priority: index + 1,
    status: "draft" as const,
    createdBy: "human:manager",
    approvedBy: null,
    lastUpdated: "2026-09-03T04:00:00.000Z",
    notes: null,
    parameters: structuredClone(rule.parameters),
  })),
})) as unknown as AdvancedSlaSectionV2[];

export const literalNineDomainV2Draft = {
  id: "draft-nine-v2",
  name: "Nine domains v2",
  description: "Typed nine-domain operational policy",
  status: "draft",
  version: 4,
  schemaVersion: 2,
  sections: literalNineDomainV2Sections,
  autoSend: { enabled: false, stages: [], channels: [], risks: [] },
} as const;
