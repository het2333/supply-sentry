import {
  ADVANCED_SLA_CHANNELS,
  ADVANCED_SLA_DOMAINS,
  ADVANCED_SLA_RISKS,
  ADVANCED_SLA_ROUTES,
  ADVANCED_SLA_STAGES,
  ADVANCED_SLA_V2_PARAMETER_FIELDS,
  ADVANCED_SLA_V2_STATUSES,
  defaultAdvancedSlaV2Parameters,
  normalizeAdvancedSlaSections,
  normalizeAdvancedSlaV2Sections,
  type AdvancedSlaAutoSend,
  type AdvancedSlaChannel,
  type AdvancedSlaDomain,
  type AdvancedSlaRisk,
  type AdvancedSlaRoute,
  type AdvancedSlaRule,
  type AdvancedSlaRuleV2,
  type AdvancedSlaRuleV2Parameters,
  type AdvancedSlaSection,
  type AdvancedSlaSectionV2,
  type AdvancedSlaStage,
} from "@readywork/advanced-sla-contract";

export { ADVANCED_SLA_CHANNELS, ADVANCED_SLA_DOMAINS, ADVANCED_SLA_RISKS, ADVANCED_SLA_ROUTES, ADVANCED_SLA_STAGES, ADVANCED_SLA_V2_PARAMETER_FIELDS, ADVANCED_SLA_V2_STATUSES };
export type { AdvancedSlaAutoSend, AdvancedSlaDomain, AdvancedSlaRule, AdvancedSlaRuleV2, AdvancedSlaRuleV2Parameters, AdvancedSlaSection, AdvancedSlaSectionV2 };
export type Stage = AdvancedSlaStage;
export type Route = AdvancedSlaRoute;
export type Risk = AdvancedSlaRisk;
export type Channel = AdvancedSlaChannel;
export type ProfileStatus = "draft" | "published" | "retired";

export interface AdvancedSlaUpgradeIssue { rowNumber: number; normalizedRuleId: string | null; severity: "error" | "warning"; field: string; code: string; message: string }
export interface AdvancedSlaUpgradePreview { fromSchemaVersion: 1; toSchemaVersion: 2; ready: false; validationResults: AdvancedSlaUpgradeIssue[] }
interface AdvancedSlaProfileBase {
  id: string; name: string; description: string; status: ProfileStatus; version: number; autoSend: AdvancedSlaAutoSend;
  createdBy?: string; updatedBy?: string; publishedBy?: string | null; createdAt?: string; updatedAt?: string; publishedAt?: string | null;
}
export interface AdvancedSlaProfileV1 extends AdvancedSlaProfileBase { schemaVersion: 1; sections: AdvancedSlaSection[]; upgradePreview: AdvancedSlaUpgradePreview }
export interface AdvancedSlaProfileV2 extends AdvancedSlaProfileBase { schemaVersion: 2; sections: AdvancedSlaSectionV2[] }
export type AdvancedSlaProfile = AdvancedSlaProfileV1 | AdvancedSlaProfileV2;

export interface EditorState {
  schemaVersion: 2; draftId: string; expectedVersion: number; name: string; description: string;
  sections: AdvancedSlaSectionV2[]; autoSend: AdvancedSlaAutoSend; dirty: boolean;
}
export interface AdvancedSlaDependencyOption { id: string; name: string; domain: AdvancedSlaDomain }

export function isAdvancedSlaProfileV2(profile: AdvancedSlaProfile | null | undefined): profile is AdvancedSlaProfileV2 { return profile?.schemaVersion === 2; }
export function createEditorState(profile: AdvancedSlaProfileV2): EditorState {
  return { schemaVersion: 2, draftId: profile.id, expectedVersion: profile.version, name: profile.name, description: profile.description, sections: structuredClone(profile.sections), autoSend: structuredClone(profile.autoSend), dirty: false };
}
export function updateEditorName(state: EditorState, name: string): EditorState { return { ...state, name, dirty: true }; }
export function updateEditorDescription(state: EditorState, description: string): EditorState { return { ...state, description, dirty: true }; }

export function updateEditorRule(state: EditorState, domain: AdvancedSlaDomain, id: string, patch: Partial<AdvancedSlaRuleV2>): EditorState {
  return { ...state, sections: state.sections.map((section) => {
    if (section.domain !== domain) return section;
    const current = section.rules.find((rule) => rule.ruleId === id) ?? newLocalRule(domain, id);
    const next = { ...current, ...patch, schemaVersion: 2 as const, ruleId: patch.ruleId ?? id, domain, parameters: patch.parameters ?? current.parameters } as AdvancedSlaRuleV2;
    return { ...section, rules: [...section.rules.filter((rule) => rule.ruleId !== id), next] };
  }), dirty: true };
}
export function updateRuleParameter(rule: AdvancedSlaRuleV2, key: string, value: unknown): AdvancedSlaRuleV2 {
  const parameters = { ...(rule.parameters as unknown as Record<string, unknown>), [key]: value } as unknown as AdvancedSlaRuleV2Parameters;
  const nameKeys: Partial<Record<AdvancedSlaDomain, string>> = { production_service_milestones: "milestoneName", communication_escalation: "eventType", payment_terms: "paymentTerm", logistics_planning: "incoterm", logistics_handover: "documentInformationName", transit_monitoring: "transportMode", regulatory_import_approval: "approvalDocumentName", customs_clearance: "destinationCountry", quality_inspection_grn: "inspectionType" };
  const next: AdvancedSlaRuleV2 = { ...rule, parameters };
  if (nameKeys[rule.domain] === key && typeof value === "string") next.name = value;
  if (["stage", "blockingStage", "requiredByStage", "requiredBeforeStage"].includes(key) && typeof value === "string" && ADVANCED_SLA_STAGES.includes(value as typeof ADVANCED_SLA_STAGES[number])) next.stage = value as typeof ADVANCED_SLA_STAGES[number];
  if (["riskAtEscalation", "riskLevel", "missingItemRisk", "riskEscalationRule", "riskEscalationLevel"].includes(key) && typeof value === "string") next.risk = value.toLowerCase() as AdvancedSlaRuleV2["risk"];
  if (key === "communicationChannel" && typeof value === "string") next.channel = value === "WhatsApp" ? "whatsapp" : "email";
  return next;
}
function dependencyParameterKey(rule: AdvancedSlaRuleV2): 'blockingRuleIds' | 'dependencyRuleIds' | 'grnBlockingRuleIds' | null {
  return rule.parameters.domain === 'production_service_milestones' || rule.parameters.domain === 'customs_clearance' ? 'blockingRuleIds'
    : rule.parameters.domain === 'regulatory_import_approval' ? 'dependencyRuleIds'
      : rule.parameters.domain === 'quality_inspection_grn' ? 'grnBlockingRuleIds' : null;
}
export function advancedSlaDependencyOptions(state: EditorState, currentRuleId: string): AdvancedSlaDependencyOption[] {
  return state.sections.flatMap((section) => section.rules.filter((rule) => rule.ruleId !== currentRuleId).map((rule) => ({ id: rule.ruleId, name: rule.name, domain: section.domain })));
}
export function ruleParameterValue(rule: AdvancedSlaRuleV2, key: string): unknown { return (rule.parameters as unknown as Record<string, unknown>)[key]; }
export function updateSectionEnabled(state: EditorState, domain: AdvancedSlaDomain, enabled: boolean): EditorState { return { ...state, sections: state.sections.map((section) => section.domain === domain ? { ...section, enabled } : section), dirty: true }; }
export function removeEditorRule(state: EditorState, domain: AdvancedSlaDomain, id: string): EditorState {
  return { ...state, sections: state.sections.map((section) => ({ ...section, rules: section.rules
    .filter((rule) => section.domain !== domain || rule.ruleId !== id)
    .map((rule) => {
      const key = dependencyParameterKey(rule); if (!key) return rule;
      const dependencies = ruleParameterValue(rule, key);
      return Array.isArray(dependencies) && dependencies.includes(id) ? updateRuleParameter(rule, key, dependencies.filter((dependency) => dependency !== id)) : rule;
    }) })), dirty: true };
}
export function patchAutoSend(state: EditorState, patch: Partial<AdvancedSlaAutoSend>): EditorState { return { ...state, autoSend: { ...state.autoSend, ...patch }, dirty: true }; }

export function newLocalRule(domain: AdvancedSlaDomain, id: string = `local-${crypto.randomUUID()}`): AdvancedSlaRuleV2 {
  const timestamp = new Date().toISOString();
  return { schemaVersion: 2, ruleId: id, name: "", domain, companyCode: "", businessUnit: "", stage: "po_sent", route: "all", risk: "all", channel: "email", effectiveFrom: timestamp.slice(0, 10), effectiveTo: null, priority: 0, status: "draft", createdBy: "pending-server", approvedBy: null, lastUpdated: timestamp, notes: null, parameters: defaultAdvancedSlaV2Parameters(domain) };
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === "string" && allowed.includes(value as T);
const uniqueAllowed = <T extends string>(value: unknown, allowed: readonly T[], required: boolean) => Array.isArray(value) && (!required || value.length > 0) && new Set(value).size === value.length && value.every((item) => oneOf(item, allowed));
export function validateEditorState(candidate: unknown): { ok: boolean; reason?: string } {
  if (!record(candidate) || candidate.schemaVersion !== 2 || typeof candidate.name !== "string" || !candidate.name.trim()) return { ok: false, reason: "名称必填" };
  if (!record(candidate.autoSend) || typeof candidate.autoSend.enabled !== "boolean") return { ok: false, reason: "自动发送配置无效" };
  const required = candidate.autoSend.enabled;
  if (!uniqueAllowed(candidate.autoSend.stages, ADVANCED_SLA_STAGES, required) || !uniqueAllowed(candidate.autoSend.channels, ADVANCED_SLA_CHANNELS, required) || !uniqueAllowed(candidate.autoSend.risks, ADVANCED_SLA_RISKS, required)) return { ok: false, reason: "自动发送必须提供有效允许列表" };
  try { normalizeAdvancedSlaV2Sections(candidate.sections); } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : "规则字段无效或不完整" }; }
  return { ok: true };
}
function writableSections(sections: AdvancedSlaSectionV2[]) { return sections.map((section) => ({ domain: section.domain, enabled: section.enabled, rules: section.rules })); }
export function buildAdvancedSlaPatch(state: EditorState) {
  const validation = validateEditorState(state);
  return !state.dirty || !validation.ok ? null : { schemaVersion: 2, expectedVersion: state.expectedVersion, name: state.name.trim(), description: state.description.trim(), sections: writableSections(normalizeAdvancedSlaV2Sections(state.sections)), autoSend: state.autoSend };
}

type MutationProfileStatus = "draft" | "published" | "retired";
interface MutationProfile { id: string; status: MutationProfileStatus; version: number; schemaVersion: 2 }
interface MutationRuntime { profileId: string; profileVersion: number; paused: boolean; version: number }
interface MutationBatch { id: string; profileId: string; profileVersion: number; version: number; status: "applied"; sourceName: string; candidateHash: string }
interface MutationImportImpact { candidateType: "import"; candidateId: string; candidateVersion: number; profileId: string; profileVersion: number; activePurchaseOrders: number; matchedPurchaseOrders: number }
interface MutationReload { profiles: readonly unknown[]; published: unknown; draft: unknown; runtimeControl: unknown; importHistory: readonly unknown[] }
export type AdvancedSlaMutationIntent =
  | { action: "create"; targetId?: string; expectedVersion: 0 }
  | { action: "save" | "publish" | "retire"; targetId: string; expectedVersion: number }
  | { action: "runtime"; targetId: string; profileVersion: number; expectedVersion: number; paused: boolean }
  | { action: "csv_apply"; targetId: string; expectedVersion: number; batchId: string; expectedBatchVersion: number; expectedCandidateHash: string; expectedImpactPreview: MutationImportImpact };
export type AdvancedSlaMutationCorrelation = AdvancedSlaMutationIntent & { response: unknown; reloaded: unknown };

function mutationProfile(value: unknown): MutationProfile | null {
  if (!record(value) || value.schemaVersion !== 2 || typeof value.id !== "string" || !value.id.trim() || !oneOf(value.status, ["draft", "published", "retired"] as const) || !Number.isSafeInteger(value.version) || Number(value.version) < 1) return null;
  try { normalizeAdvancedSlaV2Sections(value.sections); } catch { return null; }
  return { id: value.id, status: value.status, version: Number(value.version), schemaVersion: 2 };
}
function mutationRuntime(value: unknown): MutationRuntime | null { return record(value) && typeof value.profileId === "string" && value.profileId.trim() !== "" && Number.isSafeInteger(value.profileVersion) && Number(value.profileVersion) >= 1 && typeof value.paused === "boolean" && Number.isSafeInteger(value.version) && Number(value.version) >= 1 ? { profileId: value.profileId, profileVersion: Number(value.profileVersion), paused: value.paused, version: Number(value.version) } : null; }
function mutationBatch(value: unknown): MutationBatch | null { return record(value) && typeof value.id === "string" && value.id.trim() !== "" && typeof value.profileId === "string" && value.profileId.trim() !== "" && Number.isSafeInteger(value.profileVersion) && Number(value.profileVersion) >= 1 && Number.isSafeInteger(value.version) && Number(value.version) >= 1 && value.status === "applied" && typeof value.sourceName === "string" && typeof value.candidateHash === "string" && /^[0-9a-f]{64}$/.test(value.candidateHash) ? { id: value.id, profileId: value.profileId, profileVersion: Number(value.profileVersion), version: Number(value.version), status: "applied", sourceName: value.sourceName, candidateHash: value.candidateHash } : null; }
function mutationImportImpact(value: unknown): MutationImportImpact | null { return record(value) && value.candidateType === "import" && typeof value.candidateId === "string" && value.candidateId.trim() !== "" && Number.isSafeInteger(value.candidateVersion) && Number(value.candidateVersion) >= 1 && typeof value.profileId === "string" && value.profileId.trim() !== "" && Number.isSafeInteger(value.profileVersion) && Number(value.profileVersion) >= 1 && Number.isSafeInteger(value.activePurchaseOrders) && Number(value.activePurchaseOrders) >= 0 && Number.isSafeInteger(value.matchedPurchaseOrders) && Number(value.matchedPurchaseOrders) >= 0 ? { candidateType: "import", candidateId: value.candidateId, candidateVersion: Number(value.candidateVersion), profileId: value.profileId, profileVersion: Number(value.profileVersion), activePurchaseOrders: Number(value.activePurchaseOrders), matchedPurchaseOrders: Number(value.matchedPurchaseOrders) } : null; }
function sameProfile(value: unknown, expected: MutationProfile): boolean { const parsed = mutationProfile(value); return Boolean(parsed && parsed.id === expected.id && parsed.status === expected.status && parsed.version === expected.version); }
function sameRuntime(value: unknown, expected: MutationRuntime): boolean { const parsed = mutationRuntime(value); return Boolean(parsed && parsed.profileId === expected.profileId && parsed.profileVersion === expected.profileVersion && parsed.paused === expected.paused && parsed.version === expected.version); }
function sameBatch(value: unknown, expected: MutationBatch): boolean { const parsed = mutationBatch(value); return Boolean(parsed && parsed.id === expected.id && parsed.profileId === expected.profileId && parsed.profileVersion === expected.profileVersion && parsed.version === expected.version && parsed.status === expected.status && parsed.candidateHash === expected.candidateHash); }

export function mutationStateAfterReload(mutated: boolean, reloaded: boolean, correlation?: AdvancedSlaMutationCorrelation): { status: "success" | "error" } {
  if (!mutated || !reloaded) return { status: "error" }; if (!correlation) return { status: "success" };
  if (!record(correlation.response) || !record(correlation.reloaded) || !Array.isArray(correlation.reloaded.profiles)) return { status: "error" };
  const root = correlation.reloaded as unknown as MutationReload;
  if (correlation.action === "runtime") {
    const runtime = mutationRuntime(correlation.response.item);
    return { status: runtime && runtime.profileId === correlation.targetId && runtime.profileVersion === correlation.profileVersion && runtime.version === correlation.expectedVersion + 1 && runtime.paused === correlation.paused && sameRuntime(root.runtimeControl, runtime) ? "success" : "error" };
  }
  const profile = mutationProfile(correlation.response.item);
  const expectedStatus: MutationProfileStatus = correlation.action === "retire" ? "retired" : correlation.action === "publish" ? "published" : "draft";
  const expectedVersion = correlation.action === "create" ? 1 : correlation.expectedVersion + 1;
  const targetMatches = Boolean(profile && (!correlation.targetId || profile.id === correlation.targetId) && profile.status === expectedStatus && profile.version === expectedVersion);
  const rootMatches = Boolean(profile && root.profiles.some((item) => sameProfile(item, profile)) && (expectedStatus === "published" ? sameProfile(root.published, profile) : expectedStatus === "draft" ? sameProfile(root.draft, profile) : root.published === null));
  if (!targetMatches || !rootMatches) return { status: "error" }; if (correlation.action !== "csv_apply") return { status: "success" };
  const batch = mutationBatch(correlation.response.batch); const impact = mutationImportImpact(correlation.response.impactPreview); const expectedImpact = correlation.expectedImpactPreview;
  const batchMatches = Boolean(batch && batch.id === correlation.batchId && batch.profileId === correlation.targetId && batch.profileVersion === correlation.expectedVersion && batch.version === correlation.expectedBatchVersion + 1 && batch.candidateHash === correlation.expectedCandidateHash && typeof correlation.response.replayed === "boolean" && Array.isArray(root.importHistory) && root.importHistory.some((item) => sameBatch(item, batch)));
  const impactMatches = Boolean(impact && impact.candidateType === expectedImpact.candidateType && impact.candidateId === expectedImpact.candidateId && impact.candidateVersion === expectedImpact.candidateVersion && impact.profileId === expectedImpact.profileId && impact.profileVersion === expectedImpact.profileVersion && impact.activePurchaseOrders === expectedImpact.activePurchaseOrders && impact.matchedPurchaseOrders === expectedImpact.matchedPurchaseOrders);
  return { status: batchMatches && impactMatches ? "success" : "error" };
}
export function canRunMutation(dirty: boolean, action: "save" | "publish" | "retire" | "pause" | "csv") { return dirty && action !== "save" ? { ok: false, reason: "请先保存或明确放弃本地修改" } : { ok: true }; }
export function validateLegacyAdvancedSlaSections(value: unknown): AdvancedSlaSection[] | null { try { return normalizeAdvancedSlaSections(value); } catch { return null; } }
