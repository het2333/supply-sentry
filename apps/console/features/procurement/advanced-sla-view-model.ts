import {
  ADVANCED_SLA_CHANNELS,
  ADVANCED_SLA_DOMAINS,
  ADVANCED_SLA_RISKS,
  ADVANCED_SLA_ROUTES,
  ADVANCED_SLA_STAGES,
  type AdvancedSlaAutoSend,
  type AdvancedSlaProfile,
  type AdvancedSlaRule,
  type AdvancedSlaRuleV2,
  type AdvancedSlaSection,
  type AdvancedSlaSectionV2,
} from "./advanced-sla-editor-state";
import { normalizeAdvancedSlaSections, normalizeAdvancedSlaV2Sections } from "@readywork/advanced-sla-contract";

export const ADVANCED_SLA_DOMAIN_LABELS = ADVANCED_SLA_DOMAINS;
export const ADVANCED_SLA_DOMAIN_NAMES: Record<string, string> = {
  production_service_milestones: "生产／服务里程碑",
  communication_escalation: "沟通与升级规则",
  payment_terms: "付款条款规则",
  logistics_planning: "物流规划规则",
  logistics_handover: "物流交接要求",
  transit_monitoring: "在途监控规则",
  regulatory_import_approval: "监管与进口审批规则",
  customs_clearance: "清关规则",
  quality_inspection_grn: "质量检验与收货规则",
};

export interface AdvancedSlaRuntimeControl { profileId: string; profileVersion: number; paused: boolean; version: number; updatedBy?: string; updatedAt?: string }
export interface AdvancedSlaPermissions { read: boolean; configure: boolean; approve: boolean }
export interface AdvancedSlaReadiness { baseSlaPublished: boolean; communicationIdentityActive: boolean; emailConnected: boolean; whatsappConnected: boolean }
export interface AdvancedSlaImpact {
  activePurchaseOrders: number;
  matchedPurchaseOrders: number;
  candidateType?: "profile" | "import";
  candidateId?: string;
  candidateVersion?: number;
  profileId?: string;
  profileVersion?: number;
}
export interface AdvancedSlaExactImpact extends AdvancedSlaImpact {
  candidateType: "profile" | "import";
  candidateId: string;
  candidateVersion: number;
  profileId: string;
  profileVersion: number;
}
export interface AdvancedSlaImportPreview {
  id: string;
  profileId: string;
  profileVersion: number;
  version: number;
  status: "previewed";
  createdAt: string;
  schemaVersion: 2;
  templateVersion: number;
  domain: typeof ADVANCED_SLA_DOMAINS[number];
  sourceName: string;
  sourceSha256: string;
  candidateHash: string;
  totalCount: number;
  validCount: number;
  invalidCount: number;
  warningCount: number;
  validationResults: AdvancedSlaValidationResult[];
  validatedAt: string;
  summary: { totalRows: number; validRows: number; invalidRows: number; warnings: number };
  impactPreview: AdvancedSlaExactImpact & { candidateType: "import" };
}
export interface AdvancedSlaValidationResult { rowNumber: number; normalizedRuleId: string | null; severity: "error" | "warning"; field: string; code: string; message: string }
export interface AdvancedSlaEvent { profile_id: string; actor_id: string; action: string; detail: Record<string, unknown>; created_at: string }
export interface AdvancedSlaImportHistory { id: string; profileId: string; profileVersion: number; version: number; sourceName: string; status: "previewed" | "applied" | "failed"; schemaVersion: number; templateVersion: number; domain: string; sourceSha256: string; candidateHash: string; totalCount: number; validCount: number; invalidCount: number; warningCount: number; validationResults: AdvancedSlaValidationResult[]; validatedAt: string | null; summary: Record<string, number>; error: { code: string; message: string } | null; createdBy: string; appliedBy: string | null; createdAt: string; updatedAt: string; appliedAt: string | null }
export interface AdvancedSlaDomainView { id: typeof ADVANCED_SLA_DOMAINS[number]; name: string; enabled: boolean; ruleCount: number; enabledRuleCount: number; rules: Array<AdvancedSlaRule | AdvancedSlaRuleV2> }
export interface AdvancedSlaReadinessState { state: "disabled" | "not_ready" | "ready" | "paused"; reason: string }
export interface AdvancedSlaDashboardView {
  state: "error" | "empty" | "draft" | "published";
  domains: AdvancedSlaDomainView[];
  published: AdvancedSlaProfile | null;
  draft: AdvancedSlaProfile | null;
  profiles: AdvancedSlaProfile[];
  runtimeControl: AdvancedSlaRuntimeControl | null;
  permissions: AdvancedSlaPermissions;
  readiness: AdvancedSlaReadiness;
  impact: AdvancedSlaImpact;
  publishedRuntime: AdvancedSlaReadinessState;
  draftPublication: AdvancedSlaReadinessState;
  /** Backward-compatible display alias for the active published runtime. */
  autoSend: AdvancedSlaReadinessState;
  importHistory: AdvancedSlaImportHistory[];
  events: AdvancedSlaEvent[];
}
export type AdvancedSlaView = AdvancedSlaDashboardView;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNonBlank = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim());
const isVersion = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 1;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const allowed = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === "string" && values.includes(value as T);
const allowedArray = <T extends string>(value: unknown, values: readonly T[]): value is T[] => Array.isArray(value) && new Set(value).size === value.length && value.every((item) => allowed(item, values));

function parseSections(value: unknown): AdvancedSlaSection[] | null {
  try { return normalizeAdvancedSlaSections(value); }
  catch { return null; }
}
function parseV2Sections(value: unknown): AdvancedSlaSectionV2[] | null { try { return normalizeAdvancedSlaV2Sections(value); } catch { return null; } }

function parseAutoSend(value: unknown): AdvancedSlaAutoSend | null {
  if (!isRecord(value) || !isBoolean(value.enabled) || !allowedArray(value.stages, ADVANCED_SLA_STAGES) || !allowedArray(value.channels, ADVANCED_SLA_CHANNELS) || !allowedArray(value.risks, ADVANCED_SLA_RISKS)) return null;
  if (value.enabled && (!value.stages.length || !value.channels.length || !value.risks.length)) return null;
  return { enabled: value.enabled, stages: value.stages, channels: value.channels, risks: value.risks };
}

function parseProfile(value: unknown): AdvancedSlaProfile | null {
  if (!isRecord(value) || !isNonBlank(value.id) || !isNonBlank(value.name) || typeof value.description !== "string" || !allowed(value.status, ["draft", "published", "retired"] as const) || !isVersion(value.version)) return null;
  const autoSend = parseAutoSend(value.autoSend);
  if (!autoSend) return null;
  if (value.schemaVersion === 2) {
    const sections = parseV2Sections(value.sections);
    return sections ? { id: value.id, name: value.name, description: value.description, status: value.status, version: value.version, schemaVersion: 2, sections, autoSend } : null;
  }
  if (value.schemaVersion !== 1 || !isRecord(value.upgradePreview) || value.upgradePreview.fromSchemaVersion !== 1 || value.upgradePreview.toSchemaVersion !== 2 || value.upgradePreview.ready !== false || !Array.isArray(value.upgradePreview.validationResults)) return null;
  const sections = parseSections(value.sections);
  const validationResults = parseValidationResults(value.upgradePreview.validationResults);
  return sections && validationResults ? { id: value.id, name: value.name, description: value.description, status: value.status, version: value.version, schemaVersion: 1, sections, autoSend, upgradePreview: { fromSchemaVersion: 1, toSchemaVersion: 2, ready: false, validationResults } } : null;
}

function parseImpact(value: unknown, exactRequired = false): AdvancedSlaImpact | null {
  if (!isRecord(value) || !isCount(value.activePurchaseOrders) || !isCount(value.matchedPurchaseOrders)) return null;
  const candidateKeys = ["candidateType", "candidateId", "candidateVersion", "profileId", "profileVersion"] as const;
  const candidateFields = candidateKeys.filter((key) => value[key] !== undefined);
  if (candidateFields.length === 0) return exactRequired ? null : { activePurchaseOrders: value.activePurchaseOrders, matchedPurchaseOrders: value.matchedPurchaseOrders };
  if (candidateFields.length !== candidateKeys.length || !allowed(value.candidateType, ["profile", "import"] as const) || !isNonBlank(value.candidateId) || !isVersion(value.candidateVersion) || !isNonBlank(value.profileId) || !isVersion(value.profileVersion)) return null;
  return { candidateType: value.candidateType, candidateId: value.candidateId, candidateVersion: value.candidateVersion, profileId: value.profileId, profileVersion: value.profileVersion, activePurchaseOrders: value.activePurchaseOrders, matchedPurchaseOrders: value.matchedPurchaseOrders };
}

function parseValidationResults(value: unknown): AdvancedSlaValidationResult[] | null {
  if (!Array.isArray(value)) return null;
  const results: AdvancedSlaValidationResult[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isCount(item.rowNumber) || (item.normalizedRuleId !== null && !isNonBlank(item.normalizedRuleId)) || !allowed(item.severity, ["error", "warning"] as const) || !isNonBlank(item.field) || !isNonBlank(item.code) || !isNonBlank(item.message)) return null;
    results.push({ rowNumber: item.rowNumber, normalizedRuleId: item.normalizedRuleId, severity: item.severity, field: item.field, code: item.code, message: item.message });
  }
  return results;
}

export function parseAdvancedSlaImportPreview(value: unknown): AdvancedSlaImportPreview | null {
  if (!isRecord(value) || !isNonBlank(value.id) || !isNonBlank(value.profileId) || !isVersion(value.profileVersion) || !isVersion(value.version) || value.status !== "previewed" || value.schemaVersion !== 2 || !isVersion(value.templateVersion) || !allowed(value.domain, ADVANCED_SLA_DOMAINS) || typeof value.sourceName !== "string" || !isNonBlank(value.sourceSha256) || !/^[0-9a-f]{64}$/.test(value.sourceSha256) || !isNonBlank(value.candidateHash) || !/^[0-9a-f]{64}$/.test(value.candidateHash) || !isCount(value.totalCount) || !isCount(value.validCount) || !isCount(value.invalidCount) || !isCount(value.warningCount) || !isNonBlank(value.validatedAt) || !isNonBlank(value.createdAt) || !isRecord(value.summary)) return null;
  if (!isCount(value.summary.totalRows) || !isCount(value.summary.validRows) || !isCount(value.summary.invalidRows) || !isCount(value.summary.warnings)) return null;
  const validationResults = parseValidationResults(value.validationResults);
  if (!validationResults || value.totalCount !== value.summary.totalRows || value.validCount !== value.summary.validRows || value.invalidCount !== value.summary.invalidRows || value.warningCount !== value.summary.warnings) return null;
  const impact = parseImpact(value.impactPreview, true);
  if (!impact || impact.candidateType !== "import" || impact.candidateId !== value.id || impact.candidateVersion !== value.version || impact.profileId !== value.profileId || impact.profileVersion !== value.profileVersion) return null;
  return {
    id: value.id,
    profileId: value.profileId,
    profileVersion: value.profileVersion,
    version: value.version,
    status: "previewed",
    schemaVersion: 2,
    templateVersion: value.templateVersion,
    domain: value.domain,
    sourceName: value.sourceName,
    sourceSha256: value.sourceSha256,
    candidateHash: value.candidateHash,
    totalCount: value.totalCount,
    validCount: value.validCount,
    invalidCount: value.invalidCount,
    warningCount: value.warningCount,
    validationResults,
    validatedAt: value.validatedAt,
    createdAt: value.createdAt,
    summary: { totalRows: value.summary.totalRows, validRows: value.summary.validRows, invalidRows: value.summary.invalidRows, warnings: value.summary.warnings },
    impactPreview: impact as AdvancedSlaExactImpact & { candidateType: "import" },
  };
}

export function reconcileAdvancedSlaImportPreview(
  preview: AdvancedSlaImportPreview | null,
  refreshedDraft: Pick<AdvancedSlaProfile, "id" | "version"> | null,
  staleOrConflict = false,
): AdvancedSlaImportPreview | null {
  if (staleOrConflict || !preview || !refreshedDraft) return null;
  return preview.profileId === refreshedDraft.id && preview.profileVersion === refreshedDraft.version ? preview : null;
}

function profileKey(profile: AdvancedSlaProfile): string {
  return JSON.stringify([profile.id, profile.status, profile.version]);
}

function hasExactProfile(profiles: readonly AdvancedSlaProfile[], candidate: AdvancedSlaProfile): boolean {
  return profiles.some((profile) => profileKey(profile) === profileKey(candidate));
}

function hasCanonicalDraftSet(profiles: readonly AdvancedSlaProfile[], drafts: readonly AdvancedSlaProfile[]): boolean {
  const canonicalDrafts = profiles.filter((profile) => profile.status === "draft");
  return canonicalDrafts.length === drafts.length
    && canonicalDrafts.every((profile) => hasExactProfile(drafts, profile))
    && drafts.every((profile) => hasExactProfile(canonicalDrafts, profile));
}

function emptyDomains(): AdvancedSlaDomainView[] { return ADVANCED_SLA_DOMAINS.map((id) => ({ id, name: ADVANCED_SLA_DOMAIN_NAMES[id] ?? id, enabled: false, ruleCount: 0, enabledRuleCount: 0, rules: [] })); }
function errorView(): AdvancedSlaDashboardView { const invalid: AdvancedSlaReadinessState = { state: "disabled", reason: "接口返回无效数据" }; return { state: "error", domains: emptyDomains(), published: null, draft: null, profiles: [], runtimeControl: null, permissions: { read: false, configure: false, approve: false }, readiness: { baseSlaPublished: false, communicationIdentityActive: false, emailConnected: false, whatsappConnected: false }, impact: { activePurchaseOrders: 0, matchedPurchaseOrders: 0 }, publishedRuntime: invalid, draftPublication: invalid, autoSend: invalid, importHistory: [], events: [] }; }

function parseImportHistory(value: unknown): AdvancedSlaImportHistory | null {
  if (!isRecord(value) || !isNonBlank(value.id) || !isNonBlank(value.profileId) || !isVersion(value.profileVersion) || !isVersion(value.version) || typeof value.sourceName !== "string" || !allowed(value.status, ["previewed", "applied", "failed"] as const) || !isRecord(value.summary) || !isVersion(value.schemaVersion) || !isVersion(value.templateVersion) || typeof value.domain !== "string" || typeof value.sourceSha256 !== "string" || typeof value.candidateHash !== "string" || !isCount(value.totalCount) || !isCount(value.validCount) || !isCount(value.invalidCount) || !isCount(value.warningCount) || !isNonBlank(value.createdBy) || !isNonBlank(value.createdAt) || !isNonBlank(value.updatedAt) || (value.validatedAt !== null && !isNonBlank(value.validatedAt)) || (value.appliedBy !== null && value.appliedBy !== undefined && !isNonBlank(value.appliedBy)) || (value.appliedAt !== null && value.appliedAt !== undefined && !isNonBlank(value.appliedAt))) return null;
  const summary: Record<string, number> = {};
  for (const [key, count] of Object.entries(value.summary)) { if (!isCount(count)) return null; summary[key] = count; }
  const validationResults = parseValidationResults(value.validationResults); if (!validationResults) return null;
  let error: AdvancedSlaImportHistory["error"] = null;
  if (value.error !== null && value.error !== undefined) { if (!isRecord(value.error) || !isNonBlank(value.error.code) || !isNonBlank(value.error.message)) return null; error = { code: value.error.code, message: value.error.message }; }
  if ((value.status === "failed") !== Boolean(error)) return null;
  return { id: value.id, profileId: value.profileId, profileVersion: value.profileVersion, version: value.version, sourceName: value.sourceName, status: value.status, schemaVersion: value.schemaVersion, templateVersion: value.templateVersion, domain: value.domain, sourceSha256: value.sourceSha256, candidateHash: value.candidateHash, totalCount: value.totalCount, validCount: value.validCount, invalidCount: value.invalidCount, warningCount: value.warningCount, validationResults, validatedAt: typeof value.validatedAt === "string" ? value.validatedAt : null, summary, error, createdBy: value.createdBy, appliedBy: typeof value.appliedBy === "string" ? value.appliedBy : null, createdAt: value.createdAt, updatedAt: value.updatedAt, appliedAt: typeof value.appliedAt === "string" ? value.appliedAt : null };
}

function policyReadiness(profile: AdvancedSlaProfile | null, readiness: AdvancedSlaReadiness): AdvancedSlaReadinessState {
  if (!profile) return { state: "disabled", reason: "未创建配置" };
  if (!profile.autoSend.enabled) return { state: "disabled", reason: "自动发送未启用" };
  const selectedChannelReady = profile.autoSend.channels.some((channel) => channel === "email" ? readiness.emailConnected : readiness.whatsappConnected);
  return readiness.baseSlaPublished && readiness.communicationIdentityActive && selectedChannelReady
    ? { state: "ready", reason: "基础 SLA、沟通身份与允许渠道已就绪" }
    : { state: "not_ready", reason: "基础 SLA、沟通身份或允许渠道未就绪" };
}

export function normalizeAdvancedSlaDashboard(payload: unknown): AdvancedSlaDashboardView {
  if (!isRecord(payload) || !Array.isArray(payload.domains) || payload.domains.length !== ADVANCED_SLA_DOMAINS.length || payload.domains.some((item, index) => !isRecord(item) || item.id !== ADVANCED_SLA_DOMAINS[index]) || !Array.isArray(payload.profiles) || !Array.isArray(payload.draftProfiles) || !Array.isArray(payload.importHistory) || !isRecord(payload.permissions) || !isBoolean(payload.permissions.read) || !isBoolean(payload.permissions.configure) || !isBoolean(payload.permissions.approve) || !isRecord(payload.readiness) || !isBoolean(payload.readiness.baseSlaPublished) || !isBoolean(payload.readiness.communicationIdentityActive) || !isBoolean(payload.readiness.emailConnected) || !isBoolean(payload.readiness.whatsappConnected) || !Array.isArray(payload.recentEvents)) return errorView();
  const rootImpact = parseImpact(payload.impactPreview);
  if (!rootImpact) return errorView();
  const profiles = payload.profiles.map(parseProfile); const drafts = payload.draftProfiles.map(parseProfile); const published = payload.publishedProfile === null ? null : parseProfile(payload.publishedProfile);
  if (profiles.some((item) => !item) || drafts.some((item) => !item || item.status !== "draft") || (payload.publishedProfile !== null && (!published || published.status !== "published"))) return errorView();
  let runtimeControl: AdvancedSlaRuntimeControl | null = null;
  if (payload.runtimeControl !== null && payload.runtimeControl !== undefined) { const item = payload.runtimeControl; if (!isRecord(item) || !isNonBlank(item.profileId) || item.profileId !== published?.id || !isVersion(item.profileVersion) || item.profileVersion !== published?.version || !isBoolean(item.paused) || !isVersion(item.version) || (item.updatedBy !== undefined && typeof item.updatedBy !== "string") || (item.updatedAt !== undefined && typeof item.updatedAt !== "string")) return errorView(); runtimeControl = { profileId: item.profileId, profileVersion: item.profileVersion, paused: item.paused, version: item.version, ...(typeof item.updatedBy === "string" ? { updatedBy: item.updatedBy } : {}), ...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}) }; }
  const events: AdvancedSlaEvent[] = [];
  for (const event of payload.recentEvents) { if (!isRecord(event) || !isNonBlank(event.profile_id) || !isNonBlank(event.actor_id) || !isNonBlank(event.action) || !isRecord(event.detail) || !isNonBlank(event.created_at)) return errorView(); events.push({ profile_id: event.profile_id, actor_id: event.actor_id, action: event.action, detail: event.detail, created_at: event.created_at }); }
  const typedProfiles = profiles as AdvancedSlaProfile[];
  const typedDrafts = drafts as AdvancedSlaProfile[];
  const importPreview = payload.importPreview === undefined ? null : parseAdvancedSlaImportPreview(payload.importPreview);
  if (payload.importPreview !== undefined && (!importPreview || importPreview.profileId !== typedDrafts[0]?.id || importPreview.profileVersion !== typedDrafts[0]?.version)) return errorView();
  const importHistory = payload.importHistory.map(parseImportHistory);
  if (importHistory.some((item) => !item)) return errorView();
  const profileIds = new Set<string>();
  if (typedProfiles.some((profile) => profileIds.has(profile.id) || !profileIds.add(profile.id))) return errorView();
  const publishedProfiles = typedProfiles.filter((profile) => profile.status === "published");
  if (publishedProfiles.length !== (published === null ? 0 : 1)
    || (published !== null && (!hasExactProfile(typedProfiles, published) || !hasExactProfile(publishedProfiles, published)))
    || !hasCanonicalDraftSet(typedProfiles, typedDrafts)) return errorView();
  const source = typedDrafts[0] ?? published;
  const domains = emptyDomains();
  if (source) for (const section of source.sections) {
    const domain = domains.find((item) => item.id === section.domain)!;
    domain.enabled = section.enabled;
    domain.rules = [...section.rules];
    domain.ruleCount = section.rules.length;
    domain.enabledRuleCount = section.rules.filter((rule) => "enabled" in rule ? rule.enabled : rule.status === "draft" || rule.status === "active").length;
  }
  const permissions = { read: payload.permissions.read, configure: payload.permissions.configure, approve: payload.permissions.approve };
  const readiness = { baseSlaPublished: payload.readiness.baseSlaPublished, communicationIdentityActive: payload.readiness.communicationIdentityActive, emailConnected: payload.readiness.emailConnected, whatsappConnected: payload.readiness.whatsappConnected };
  let publishedRuntime = policyReadiness(published, readiness);
  if (published) {
    if (!runtimeControl) publishedRuntime = !permissions.configure && !permissions.approve ? { state: "disabled", reason: "当前账号为只读" } : { state: "not_ready", reason: "缺少与已发布版本绑定的运行控制" };
    else if (runtimeControl.paused) publishedRuntime = { state: "paused", reason: "Kill switch 已暂停" };
  }
  const draftPublication = policyReadiness(typedDrafts[0] ?? null, readiness);
  const autoSend = published ? publishedRuntime : draftPublication;
  return { state: published ? (typedDrafts[0] ? "draft" : "published") : typedDrafts[0] ? "draft" : "empty", domains, published, draft: typedDrafts[0] ?? null, profiles: typedProfiles, runtimeControl, permissions, readiness, impact: importPreview?.impactPreview ?? rootImpact, publishedRuntime, draftPublication, autoSend, importHistory: importHistory as AdvancedSlaImportHistory[], events };
}
