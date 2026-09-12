import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import {
  ADVANCED_SLA_CHANNELS,
  ADVANCED_SLA_DOMAINS,
  ADVANCED_SLA_RISKS,
  ADVANCED_SLA_ROUTES,
  ADVANCED_SLA_STAGES,
  ADVANCED_SLA_V2_PARAMETER_FIELDS,
  AdvancedSlaContractError,
  advancedSlaRuleV2Schema,
  advancedSlaV2CsvColumns,
  normalizeAdvancedSlaSections,
  normalizeAdvancedSlaV2Sections,
  type AdvancedSlaAutoSend,
  type AdvancedSlaChannel,
  type AdvancedSlaDomain,
  type AdvancedSlaRisk,
  type AdvancedSlaRoute,
  type AdvancedSlaRule,
  type AdvancedSlaRuleV2,
  type AdvancedSlaSection,
  type AdvancedSlaSectionV2,
  type AdvancedSlaStage,
} from '@readywork/core';
import Papa from 'papaparse';
import { can, type Session } from './auth.js';
import { procurementPortfolio } from './procurement-workbench.js';

export { ADVANCED_SLA_DOMAINS };
export type { AdvancedSlaAutoSend, AdvancedSlaRule, AdvancedSlaSection };
type Domain = AdvancedSlaDomain;
type Stage = AdvancedSlaStage;
type Route = AdvancedSlaRoute;
type Risk = AdvancedSlaRisk;
type Channel = AdvancedSlaChannel;
export interface ProcurementAdvancedSlaContext { db: DatabaseSync; session: Session | null; now?: () => Date }
export type AdvancedSlaAutoSendDecisionCode =
  | 'advanced_sla_not_published'
  | 'auto_send_disabled'
  | 'kill_switch_paused'
  | 'communication_identity_missing'
  | 'channel_unavailable'
  | 'stage_not_allowed'
  | 'channel_not_allowed'
  | 'risk_not_allowed'
  | 'ready';
export interface AdvancedSlaAutoSendDecisionCandidate { stage: Stage; channel: Channel; risk: Risk }
export interface AdvancedSlaAutoSendDecision {
  allowed: boolean;
  reason: AdvancedSlaAutoSendDecisionCode;
  profileId?: string;
  profileVersion?: number;
  /** Exact connected credential selected from persisted tenant facts when ready. */
  credentialId?: string;
}
export interface AdvancedSlaAutoSendRuntimeEvent {
  profileId?: string;
  profileVersion?: number;
  draftId: string;
  purchaseOrderId: string;
  decisionCode: AdvancedSlaAutoSendDecisionCode;
  outboxId?: string;
  actorId: string;
  timestamp: string;
}

interface ProfileRow { tenant_id: string; id: string; name: string; description: string; status: 'draft' | 'published' | 'retired'; version: number; sections_json: string; auto_send_json: string; created_by: string; updated_by: string; published_by: string | null; created_at: string; updated_at: string; published_at: string | null; schema_version: number }
interface RuntimeRow { tenant_id: string; profile_id: string; profile_version: number; paused: number; version: number; updated_by: string; updated_at: string }
interface BatchRow { tenant_id: string; id: string; profile_id: string; profile_version: number; version: number; source_name: string; payload_hash: string; sections_json: string; summary_json: string; status: 'previewed' | 'applied'; error_json: string | null; created_by: string; created_at: string; updated_at: string; applied_by: string | null; applied_at: string | null; template_version: number; schema_version: number; domain: string; source_sha256: string; total_count: number; valid_count: number; invalid_count: number; warning_count: number; candidate_hash: string; validation_results_json: string; validated_at: string | null }
interface AdvancedSlaCsvValidationResult { rowNumber: number; normalizedRuleId: string | null; severity: 'error' | 'warning'; field: string; code: string; message: string }
interface AdvancedSlaImpactPreview {
  candidateType: 'profile' | 'import'; candidateId: string; candidateVersion: number;
  profileId: string; profileVersion: number; activePurchaseOrders: number; matchedPurchaseOrders: number;
}
interface ImpactPortfolioItem {
  active: boolean;
  stage: Stage;
  route: Exclude<Route, 'all'>;
  risk: Exclude<Risk, 'all'>;
  riskPublicationState: 'published' | 'provisional' | 'not_published';
}

const stages: readonly Stage[] = ADVANCED_SLA_STAGES;
const routes: readonly Route[] = ADVANCED_SLA_ROUTES;
const risks: readonly Risk[] = ADVANCED_SLA_RISKS;
const channels: readonly Channel[] = ADVANCED_SLA_CHANNELS;

/** Shared by JSON and CSV paths so imported policy data cannot bypass validation. */
export function validateAdvancedSlaSections(value: unknown): AdvancedSlaSection[] {
  try { return normalizeAdvancedSlaSections(value); }
  catch (error) { if (error instanceof AdvancedSlaContractError) throw new AdvancedSlaInputError(error.message); throw error; }
}

export function publishedAdvancedSlaProfile(db: DatabaseSync, tenantId: string): ReturnType<typeof presentProfile> | null {
  const row = db.prepare(`SELECT * FROM procurement_advanced_sla_profiles WHERE tenant_id=? AND status='published'`).get(tenantId) as ProfileRow | undefined;
  return row ? presentProfile(row) : null;
}

export function advancedSlaAutoSendDecision(db: DatabaseSync, tenantId: string, candidate: AdvancedSlaAutoSendDecisionCandidate): AdvancedSlaAutoSendDecision {
  const profile = publishedAdvancedSlaProfile(db, tenantId); if (!profile) return { allowed: false, reason: 'advanced_sla_not_published' };
  if (profile.schemaVersion !== 2) return { allowed: false, reason: 'advanced_sla_not_published' };
  const identified = { profileId: profile.id, profileVersion: profile.version };
  const runtime = runtimeControl(db, tenantId, profile.id); if (!runtime || runtime.profileVersion !== profile.version || runtime.paused) return { allowed: false, reason: 'kill_switch_paused', ...identified };
  const policy = profile.autoSend;
  if (!policy.enabled) return { allowed: false, reason: 'auto_send_disabled', ...identified };
  if (!policy.stages.includes(candidate.stage)) return { allowed: false, reason: 'stage_not_allowed', ...identified };
  if (!policy.channels.includes(candidate.channel)) return { allowed: false, reason: 'channel_not_allowed', ...identified };
  if (!policy.risks.includes('all') && !policy.risks.includes(candidate.risk)) return { allowed: false, reason: 'risk_not_allowed', ...identified };
  const dependency = autoSendDependencyFailure(db, tenantId, candidate.channel);
  if (dependency) return {
    allowed: false,
    reason: dependency === 'base_sla_not_published' ? 'advanced_sla_not_published' : dependency === 'communication_identity_inactive' ? 'communication_identity_missing' : 'channel_unavailable',
    ...identified,
  };
  return { allowed: true, reason: 'ready', ...identified, credentialId: selectedChannelCredentialId(db, tenantId, candidate.channel)! };
}

/** Persists the deliberately minimal audit record for an evaluated candidate. */
export function recordAdvancedSlaAutoSendDecision(db: DatabaseSync, tenantId: string, event: AdvancedSlaAutoSendRuntimeEvent): void {
  const profileId = event.profileId ?? 'advanced-sla:unpublished';
  const actorId = event.actorId;
  const detail = {
    profileId,
    profileVersion: event.profileVersion ?? 0,
    draftId: event.draftId,
    poId: event.purchaseOrderId,
    decisionCode: event.decisionCode,
    ...(event.outboxId ? { outboxId: event.outboxId } : {}),
    actorId,
    timestamp: event.timestamp,
  };
  runtimeEvent(db, tenantId, profileId, event.profileVersion ?? 0, actorId, 'auto_send_decision', detail, event.timestamp);
}

export async function handleProcurementAdvancedSlaRequest(req: IncomingMessage, res: ServerResponse, path: string, method: string, context: ProcurementAdvancedSlaContext): Promise<boolean> {
  const root = path === '/api/procurement/advanced-sla'; const create = path === '/api/procurement/advanced-sla/profiles';
  const profile = path.match(/^\/api\/procurement\/advanced-sla\/profiles\/([^/]+)$/); const publish = path.match(/^\/api\/procurement\/advanced-sla\/profiles\/([^/]+)\/publish$/); const retire = path.match(/^\/api\/procurement\/advanced-sla\/profiles\/([^/]+)\/retire$/);
  const template = path.match(/^\/api\/procurement\/advanced-sla\/templates\/([^/]+)$/);
  const runtime = path === '/api/procurement/advanced-sla/runtime-control'; const preview = path === '/api/procurement/advanced-sla/imports/preview'; const apply = path.match(/^\/api\/procurement\/advanced-sla\/imports\/([^/]+)\/apply$/);
  if (!root && !create && !profile && !publish && !retire && !template && !runtime && !preview && !apply) return false;
  if (!context.session) return send(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  const { db, session } = context; const now = () => (context.now?.() ?? new Date()).toISOString();
  try {
    if (root && method === 'GET') { if (!can(session, 'read')) return forbidden(res); return send(res, 200, dashboard(db, session)); }
    if (template && method === 'GET') {
      if (!can(session, 'read')) return forbidden(res);
      const domain = enumeration(pathId(template[1]!), ADVANCED_SLA_DOMAINS, 'domain');
      return sendCsv(res, advancedSlaV2Template(domain), `${domain}-advanced-sla-v2.csv`);
    }
    if (create && method === 'POST') {
      if (!can(session, 'configure')) return forbidden(res); const body = await json(req); only(body, ['schemaVersion', 'name', 'description', 'sections', 'autoSend']);
      const at = now(); const id = `advanced-sla:${randomUUID()}`; const schemaVersion = body.schemaVersion === undefined ? 1 : positive(body.schemaVersion, 'schemaVersion');
      if (schemaVersion !== 1 && schemaVersion !== 2) throw new AdvancedSlaInputError('schemaVersion 必须为 1 或 2');
      const sections = schemaVersion === 2 ? normalizeV2WritableSections(body.sections, session.humanId, at) : validateAdvancedSlaSections(body.sections); const autoSend = validateAutoSend(body.autoSend);
      tx(db, () => { db.prepare(`INSERT INTO procurement_advanced_sla_profiles (tenant_id,id,name,description,status,version,sections_json,auto_send_json,created_by,updated_by,created_at,updated_at,schema_version) VALUES (?,?,?,?,'draft',1,?,?,?,?,?,?,?)`).run(session.tenantId, id, text(body.name, 'name', 160), optionalText(body.description, 'description', 2_000), JSON.stringify(sections), JSON.stringify(autoSend), session.humanId, session.humanId, at, at, schemaVersion); profileEvent(db, session.tenantId, id, session.humanId, 'draft_created', { version: 1, schemaVersion, status: 'draft', ruleCount: countRules(sections), source: 'manual', diffSummary: { added: countRules(sections), changed: 0, removed: 0 } }, at); });
      return send(res, 201, { item: presentProfile(getProfile(db, session.tenantId, id)!) });
    }
    if (profile && method === 'PATCH') {
      if (!can(session, 'configure')) return forbidden(res); const body = await json(req); only(body, ['schemaVersion', 'expectedVersion', 'name', 'description', 'sections', 'autoSend']); const id = pathId(profile[1]!); const expected = positive(body.expectedVersion, 'expectedVersion'); const autoSend = validateAutoSend(body.autoSend); const description = body.description === undefined ? undefined : optionalText(body.description, 'description', 2_000); const at = now();
      tx(db, () => { const row = requiredProfile(db, session.tenantId, id); if (row.status !== 'draft') throw new StateError('已发布配置不可编辑'); if (row.version !== expected) throw new VersionError(row.version); const requestedSchemaVersion = body.schemaVersion === undefined ? row.schema_version : positive(body.schemaVersion, 'schemaVersion'); if (requestedSchemaVersion !== row.schema_version) throw new StateError('请使用显式 v1→v2 upgrade preview，不允许静默改写 schemaVersion'); const sections = row.schema_version === 2 ? normalizeV2WritableSections(body.sections, session.humanId, at, normalizeAdvancedSlaV2Sections(safe(row.sections_json))) : validateAdvancedSlaSections(body.sections); const changed = db.prepare(`UPDATE procurement_advanced_sla_profiles SET name=?,description=?,sections_json=?,auto_send_json=?,version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND id=? AND status='draft' AND version=?`).run(text(body.name, 'name', 160), description ?? row.description, JSON.stringify(sections), JSON.stringify(autoSend), session.humanId, at, session.tenantId, id, expected); if (changed.changes !== 1) throw new VersionError(requiredProfile(db, session.tenantId, id).version); profileEvent(db, session.tenantId, id, session.humanId, 'draft_updated', { version: expected + 1, schemaVersion: row.schema_version, status: 'draft', ruleCount: countRules(sections), source: 'manual', diffSummary: { previousRuleCount: countRules(safe(row.sections_json) as Array<{ rules: unknown[] }>), currentRuleCount: countRules(sections) } }, at); });
      return send(res, 200, { item: presentProfile(getProfile(db, session.tenantId, id)!) });
    }
    if (publish && method === 'POST') return publishProfile(res, db, session, pathId(publish[1]!), await json(req), now());
    if (retire && method === 'POST') return retireProfile(res, db, session, pathId(retire[1]!), await json(req), now());
    if (runtime && method === 'PUT') {
      if (!can(session, 'configure') || !can(session, 'approve')) return forbidden(res); const body = await json(req); only(body, ['profileId', 'profileVersion', 'expectedVersion', 'paused', 'reason']); const profileRow = publishedAdvancedSlaProfile(db, session.tenantId); if (!profileRow) throw new StateError('没有已发布的 Advanced SLA'); const requestedProfileId = text(body.profileId, 'profileId', 300); const requestedProfileVersion = positive(body.profileVersion, 'profileVersion'); const expected = positive(body.expectedVersion, 'expectedVersion'); const paused = bool(body.paused, 'paused'); const reason = text(body.reason, 'reason', 500); const at = now();
      if (requestedProfileId !== profileRow.id || requestedProfileVersion !== profileRow.version) throw new VersionError(profileRow.version);
      tx(db, () => { const current = runtimeControl(db, session.tenantId, profileRow.id); if (!current || current.profileVersion !== requestedProfileVersion || current.version !== expected) throw new VersionError(current?.version ?? 0); db.prepare('UPDATE procurement_advanced_sla_runtime_controls SET paused=?,version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND profile_id=? AND profile_version=? AND version=?').run(paused ? 1 : 0, session.humanId, at, session.tenantId, profileRow.id, requestedProfileVersion, expected); runtimeEvent(db, session.tenantId, profileRow.id, requestedProfileVersion, session.humanId, paused ? 'paused' : 'resumed', { reason, controlVersion: expected + 1 }, at); });
      return send(res, 200, { item: runtimeControl(db, session.tenantId, profileRow.id) });
    }
    if (preview && method === 'POST') {
      if (!can(session, 'configure')) return forbidden(res); const body = await json(req); only(body, ['domain', 'sourceName', 'profileId', 'expectedVersion', 'csv']); const profileId = text(body.profileId, 'profileId', 300); const expected = positive(body.expectedVersion, 'expectedVersion'); const sourceName = body.sourceName === undefined ? '' : text(body.sourceName, 'sourceName', 260); const target = requiredProfile(db, session.tenantId, profileId); if (target.status !== 'draft') throw new StateError('只能导入草稿'); if (target.version !== expected) throw new VersionError(target.version); const at = now(); const id = `advanced-sla-import:${randomUUID()}`; const rawCsv = typeof body.csv === 'string' ? body.csv : ''; const hash = digest(`${rawCsv}\n${profileId}\n${expected}`);
      if (body.domain !== undefined) {
        if (target.schema_version !== 2) throw new V2RequiredError('按域 CSV 只支持 schemaVersion 2 草稿');
        const domain = enumeration(body.domain, ADVANCED_SLA_DOMAINS, 'domain');
        let result: ReturnType<typeof sectionsFromV2Csv>;
        try { result = sectionsFromV2Csv(text(body.csv, 'csv', 500_000), domain, normalizeAdvancedSlaV2Sections(safe(target.sections_json)), session.humanId, at); }
        catch (error) {
          if (error instanceof AdvancedSlaInputError) {
            const failureDetail = { code: 'INVALID_ADVANCED_SLA_V2_CSV', message: error.message };
            tx(db, () => { insertImportBatch(db, { tenantId: session.tenantId, id, profileId, profileVersion: expected, sourceName, payloadHash: hash, sections: [], summary: { totalRows: 0, validRows: 0, invalidRows: 0, warnings: 0 }, error: failureDetail, actorId: session.humanId, at, templateVersion: 2, schemaVersion: 2, domain, sourceSha256: digest(rawCsv), candidateHash: digest('[]'), validationResults: [], totalCount: 0, validCount: 0, invalidCount: 0, warningCount: 0, validatedAt: at }); });
          }
          throw error;
        }
        tx(db, () => { insertImportBatch(db, { tenantId: session.tenantId, id, profileId, profileVersion: expected, sourceName, payloadHash: hash, sections: result.sections, summary: result.summary, error: null, actorId: session.humanId, at, templateVersion: 2, schemaVersion: 2, domain, sourceSha256: digest(rawCsv), candidateHash: result.candidateHash, validationResults: result.validationResults, totalCount: result.summary.totalRows, validCount: result.summary.validRows, invalidCount: result.summary.invalidRows, warningCount: result.summary.warnings, validatedAt: at }); });
        const batch = getBatch(db, session.tenantId, id)!;
        return send(res, 201, { item: presentBatch(batch, impactForV2Sections(db, session.tenantId, result.sections, { candidateType: 'import', candidateId: id, candidateVersion: batch.version, profileId, profileVersion: expected })) });
      }
      let sections: AdvancedSlaSection[];
      try { sections = sectionsFromCsv(text(body.csv, 'csv', 500_000)); }
      catch (error) {
        if (error instanceof AdvancedSlaInputError) {
          const failureDetail = { code: 'INVALID_ADVANCED_SLA_CSV', message: error.message };
          tx(db, () => { insertImportBatch(db, { tenantId: session.tenantId, id, profileId, profileVersion: expected, sourceName, payloadHash: hash, sections: [], summary: {}, error: failureDetail, actorId: session.humanId, at }); });
        }
        throw error;
      }
      const summary = diff(validateAdvancedSlaSections(JSON.parse(target.sections_json)), sections);
      tx(db, () => { insertImportBatch(db, { tenantId: session.tenantId, id, profileId, profileVersion: expected, sourceName, payloadHash: hash, sections, summary, error: null, actorId: session.humanId, at }); });
      const batch = getBatch(db, session.tenantId, id)!;
      return send(res, 201, { item: presentBatch(batch, impactForSections(db, session.tenantId, sections, { candidateType: 'import', candidateId: id, candidateVersion: batch.version, profileId, profileVersion: expected })) });
    }
    if (apply && method === 'POST') {
      if (!can(session, 'configure') || !can(session, 'approve')) return forbidden(res); const body = await json(req); only(body, ['expectedBatchVersion', 'expectedProfileVersion', 'expectedCandidateHash']); const id = pathId(apply[1]!); const batchExpected = positive(body.expectedBatchVersion, 'expectedBatchVersion'); const profileExpected = positive(body.expectedProfileVersion, 'expectedProfileVersion'); const expectedCandidateHash = body.expectedCandidateHash === undefined ? null : sha256(body.expectedCandidateHash, 'expectedCandidateHash'); const at = now(); let result: ProfileRow | undefined; let verifiedImpact: AdvancedSlaImpactPreview | undefined; let replayed = false;
      tx(db, () => {
        const batch = getBatch(db, session.tenantId, id); if (!batch) throw new NotFoundError('导入批次不存在');
        const target = requiredProfile(db, session.tenantId, batch.profile_id);
        if (batch.schema_version !== 2 || target.schema_version !== 2) throw new V2RequiredError('Advanced SLA v1 只读；旧 CSV 批次不能应用或隐式发布');
        if (!expectedCandidateHash || expectedCandidateHash !== batch.candidate_hash) throw new ConflictError('CSV candidate hash 已变化');
        if (batch.profile_version !== profileExpected) throw new VersionError(batch.profile_version);
        if (batch.error_json || batch.valid_count < 1) throw new StateError('没有可应用的合法 CSV 行');
        if (batch.status === 'applied') {
          if (batchExpected === batch.version - 1 && target.status === 'draft' && target.version === profileExpected + 1) { replayed = true; result = target; verifiedImpact = impactForV2Sections(db, session.tenantId, normalizeAdvancedSlaV2Sections(safe(batch.sections_json)), { candidateType: 'import', candidateId: batch.id, candidateVersion: batch.version - 1, profileId: batch.profile_id, profileVersion: batch.profile_version }); return; }
          throw new ConflictError('导入批次已用于不同版本');
        }
        if (batch.version !== batchExpected) throw new VersionError(batch.version);
        if (target.status !== 'draft' || target.version !== profileExpected) throw new VersionError(target.version);
        const candidateSections = normalizeAdvancedSlaV2Sections(safe(batch.sections_json));
        verifiedImpact = impactForV2Sections(db, session.tenantId, candidateSections, { candidateType: 'import', candidateId: batch.id, candidateVersion: batch.version, profileId: batch.profile_id, profileVersion: batch.profile_version });
        db.prepare(`UPDATE procurement_advanced_sla_profiles SET sections_json=?,version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND id=? AND status='draft' AND version=?`).run(batch.sections_json, session.humanId, at, session.tenantId, target.id, profileExpected);
        db.prepare(`UPDATE procurement_advanced_sla_import_batches SET status='applied',version=version+1,updated_at=?,applied_by=?,applied_at=? WHERE tenant_id=? AND id=? AND version=?`).run(at, session.humanId, at, session.tenantId, id, batchExpected);
        profileEvent(db, session.tenantId, target.id, session.humanId, 'import_applied_to_draft', { batchId: id, version: profileExpected + 1, schemaVersion: 2, status: 'draft', ruleCount: countRules(candidateSections), source: 'csv', diffSummary: safe(batch.summary_json), candidateHash: batch.candidate_hash, impactPreview: verifiedImpact }, at);
        result = requiredProfile(db, session.tenantId, target.id);
      });
      const appliedBatch = getBatch(db, session.tenantId, id)!;
      return send(res, 200, { item: presentProfile(result!), batch: presentBatch(appliedBatch), impactPreview: verifiedImpact, replayed });
    }
    return send(res, 405, { error: '不支持的请求方法', code: 'METHOD_NOT_ALLOWED' });
  } catch (error) { return failure(res, error); }
}

function publishProfile(res: ServerResponse, db: DatabaseSync, session: Session, id: string, body: Record<string, unknown>, at: string): true {
  if (!can(session, 'configure') || !can(session, 'approve')) return forbidden(res); only(body, ['expectedVersion']); const expected = positive(body.expectedVersion, 'expectedVersion');
  let verifiedImpact: AdvancedSlaImpactPreview | undefined;
  tx(db, () => { const row = requiredProfile(db, session.tenantId, id); if (row.status !== 'draft') throw new StateError('只能发布草稿'); if (row.version !== expected) throw new VersionError(row.version); if (row.schema_version !== 2) throw new V2RequiredError('Advanced SLA v1 只读；完成显式 upgrade validation 后才能发布'); const publishableSections = normalizeAdvancedSlaV2Sections(safe(row.sections_json)).map((section) => ({ ...section, rules: section.rules.map((rule) => ({ ...rule, status: rule.status === 'draft' ? 'active' as const : rule.status, approvedBy: rule.status === 'draft' ? session.humanId : rule.approvedBy, lastUpdated: at })) })); normalizeAdvancedSlaV2Sections(publishableSections); const publishableRow = { ...row, sections_json: JSON.stringify(publishableSections) }; verifiedImpact = impactForProfile(db, session.tenantId, publishableRow); if (parseAuto(row).enabled) assertAutoSendReadiness(db, session.tenantId, parseAuto(row)); retirePrevious(db, session.tenantId, session.humanId, at); const publishedVersion = expected + 1; db.prepare(`UPDATE procurement_advanced_sla_profiles SET sections_json=?,status='published',version=version+1,published_by=?,published_at=?,updated_by=?,updated_at=? WHERE tenant_id=? AND id=? AND version=?`).run(publishableRow.sections_json, session.humanId, at, session.humanId, at, session.tenantId, id, expected); db.prepare('INSERT INTO procurement_advanced_sla_runtime_controls (tenant_id,profile_id,profile_version,paused,version,updated_by,updated_at) VALUES (?,?,?,0,1,?,?)').run(session.tenantId, id, publishedVersion, session.humanId, at); profileEvent(db, session.tenantId, id, session.humanId, 'published', { version: publishedVersion, schemaVersion: 2, status: 'published', ruleCount: countRules(publishableSections), source: 'manual', diffSummary: { activated: publishableSections.flatMap((section) => section.rules).filter((rule) => rule.status === 'active').length }, impactPreview: verifiedImpact }, at); runtimeEvent(db, session.tenantId, id, publishedVersion, session.humanId, 'created_unpaused', { controlVersion: 1 }, at); });
  const item = getProfile(db, session.tenantId, id)!; return send(res, 200, { item: presentProfile(item), runtimeControl: runtimeControl(db, session.tenantId, id), impactPreview: verifiedImpact });
}
function retireProfile(res: ServerResponse, db: DatabaseSync, session: Session, id: string, body: Record<string, unknown>, at: string): true {
  if (!can(session, 'configure') || !can(session, 'approve')) return forbidden(res); only(body, ['expectedVersion']); const expected = positive(body.expectedVersion, 'expectedVersion'); tx(db, () => { const row = requiredProfile(db, session.tenantId, id); if (row.status !== 'published') throw new StateError('只能退役已发布配置'); if (row.version !== expected) throw new VersionError(row.version); db.prepare(`UPDATE procurement_advanced_sla_profiles SET status='retired',version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND id=? AND version=?`).run(session.humanId, at, session.tenantId, id, expected); profileEvent(db, session.tenantId, id, session.humanId, 'retired', { version: expected + 1, schemaVersion: row.schema_version, status: 'retired', ruleCount: countRules(safe(row.sections_json) as Array<{ rules: unknown[] }>), source: 'manual', diffSummary: { statusChanged: 1 } }, at); }); return send(res, 200, { item: presentProfile(getProfile(db, session.tenantId, id)!) });
}

function dashboard(db: DatabaseSync, session: Session): Record<string, unknown> {
  const profiles = db.prepare('SELECT * FROM procurement_advanced_sla_profiles WHERE tenant_id=? ORDER BY created_at DESC,id DESC').all(session.tenantId) as unknown as ProfileRow[]; const published = profiles.find((item) => item.status === 'published');
  const profileEvents = db.prepare('SELECT profile_id,actor_id,action,detail_json,created_at FROM procurement_advanced_sla_profile_events WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(session.tenantId) as unknown as Array<{ profile_id: string; actor_id: string; action: string; detail_json: string; created_at: string }>;
  const runtimeEvents = db.prepare('SELECT profile_id,profile_version,actor_id,action,detail_json,created_at FROM procurement_advanced_sla_runtime_events WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(session.tenantId) as unknown as Array<{ profile_id: string; profile_version: number | null; actor_id: string; action: string; detail_json: string; created_at: string }>;
  const batches = db.prepare('SELECT * FROM procurement_advanced_sla_import_batches WHERE tenant_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(session.tenantId) as unknown as BatchRow[];
  const recentEvents = [...profileEvents.map((event) => ({ ...event, detail: safe(event.detail_json) })), ...runtimeEvents.map((event) => { const exact = Number.isSafeInteger(event.profile_version) && Number(event.profile_version) >= 1; return { ...event, detail: { ...safe(event.detail_json), profileVersion: exact ? event.profile_version : null, profileVersionBinding: exact ? 'exact' : 'legacy_unknown', source: 'runtime' } }; }), ...batches.map((batch) => ({ profile_id: batch.profile_id, actor_id: batch.applied_by ?? batch.created_by, action: batch.error_json ? 'import_failed' : batch.status === 'applied' ? 'import_applied' : 'import_previewed', detail: { batchId: batch.id, sourceName: batch.source_name, schemaVersion: batch.schema_version, status: batch.error_json ? 'failed' : batch.status, ruleCount: batch.error_json ? 0 : countRules(safe(batch.sections_json) as Array<{ rules: unknown[] }>), source: 'csv', diffSummary: safe(batch.summary_json), error: batch.error_json ? safe(batch.error_json) : null, version: batch.version, profileVersion: batch.profile_version, domain: batch.domain, candidateHash: batch.candidate_hash }, created_at: batch.applied_at ?? batch.updated_at ?? batch.created_at }))].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const candidate = profiles.find((item) => item.status === 'draft') ?? published;
  return { domains: ADVANCED_SLA_DOMAINS.map((id) => ({ id })), profiles: profiles.map(presentProfile), publishedProfile: published ? presentProfile(published) : null, draftProfiles: profiles.filter((item) => item.status === 'draft').map(presentProfile), runtimeControl: published ? runtimeControl(db, session.tenantId, published.id) : null, importHistory: batches.map((batch) => presentBatch(batch)), recentEvents, permissions: { read: can(session, 'read'), configure: can(session, 'configure'), approve: can(session, 'approve') }, readiness: readiness(db, session.tenantId), impactPreview: candidate ? impactForProfile(db, session.tenantId, candidate) : emptyImpact(db, session.tenantId) };
}
function activeImpactPortfolio(db: DatabaseSync, tenantId: string): ImpactPortfolioItem[] {
  const portfolio = procurementPortfolio(db, tenantId) as { items?: unknown };
  if (!Array.isArray(portfolio.items)) return [];
  return (portfolio.items as ImpactPortfolioItem[]).filter((item) => item.active === true);
}
function emptyImpact(db: DatabaseSync, tenantId: string): { activePurchaseOrders: number; matchedPurchaseOrders: number } { return { activePurchaseOrders: activeImpactPortfolio(db, tenantId).length, matchedPurchaseOrders: 0 }; }
function impactForProfile(db: DatabaseSync, tenantId: string, profile: ProfileRow): AdvancedSlaImpactPreview {
  const candidate = { candidateType: 'profile' as const, candidateId: profile.id, candidateVersion: profile.version, profileId: profile.id, profileVersion: profile.version };
  return profile.schema_version === 2 ? impactForV2Sections(db, tenantId, normalizeAdvancedSlaV2Sections(safe(profile.sections_json)), candidate) : impactForSections(db, tenantId, validateAdvancedSlaSections(safe(profile.sections_json)), candidate);
}
function impactForSections(db: DatabaseSync, tenantId: string, sections: AdvancedSlaSection[], candidate: Omit<AdvancedSlaImpactPreview, 'activePurchaseOrders' | 'matchedPurchaseOrders'>): AdvancedSlaImpactPreview {
  const items = activeImpactPortfolio(db, tenantId);
  const rules = sections.filter((section) => section.enabled).flatMap((section) => section.rules.filter((rule) => rule.enabled));
  const matchedPurchaseOrders = items.filter((item) => rules.some((rule) => rule.scope.stage === item.stage
    && (rule.scope.route === 'all' || rule.scope.route === item.route)
    && (rule.scope.risk === 'all' || (item.riskPublicationState === 'published' && rule.scope.risk === item.risk)))).length;
  return { ...candidate, activePurchaseOrders: items.length, matchedPurchaseOrders };
}
function impactForV2Sections(db: DatabaseSync, tenantId: string, sections: AdvancedSlaSectionV2[], candidate: Omit<AdvancedSlaImpactPreview, 'activePurchaseOrders' | 'matchedPurchaseOrders'>): AdvancedSlaImpactPreview {
  const items = activeImpactPortfolio(db, tenantId);
  const rules = sections.filter((section) => section.enabled).flatMap((section) => section.rules.filter((rule) => rule.status === 'draft' || rule.status === 'active'));
  const matchedPurchaseOrders = items.filter((item) => rules.some((rule) => rule.stage === item.stage
    && (rule.route === 'all' || rule.route === item.route)
    && (rule.risk === 'all' || (item.riskPublicationState === 'published' && rule.risk === item.risk)))).length;
  return { ...candidate, activePurchaseOrders: items.length, matchedPurchaseOrders };
}
function readiness(db: DatabaseSync, tenantId: string): Record<string, boolean> { return { baseSlaPublished: Boolean(db.prepare("SELECT 1 FROM procurement_sla_policies WHERE tenant_id=? AND status='published'").get(tenantId)), communicationIdentityActive: Boolean(db.prepare("SELECT 1 FROM procurement_communication_identities WHERE tenant_id=? AND status='active'").get(tenantId)), emailConnected: channelCredentialReady(db, tenantId, 'email'), whatsappConnected: channelCredentialReady(db, tenantId, 'whatsapp') }; }
function selectedChannelCredentialId(db: DatabaseSync, tenantId: string, channel: Channel): string | null {
  const row = db.prepare("SELECT id FROM control_credentials WHERE tenant_id=? AND connector_id=? AND status='connected' AND last_error IS NULL ORDER BY updated_at DESC,id LIMIT 1")
    .get(tenantId, channel) as { id: string } | undefined;
  return row?.id ?? null;
}
function channelCredentialReady(db: DatabaseSync, tenantId: string, channel: Channel): boolean { return selectedChannelCredentialId(db, tenantId, channel) !== null; }
function autoSendDependencyFailure(db: DatabaseSync, tenantId: string, channel: Channel): string | null { if (!db.prepare("SELECT 1 FROM procurement_sla_policies WHERE tenant_id=? AND status='published'").get(tenantId)) return 'base_sla_not_published'; if (!db.prepare("SELECT 1 FROM procurement_communication_identities WHERE tenant_id=? AND status='active'").get(tenantId)) return 'communication_identity_inactive'; return channelCredentialReady(db, tenantId, channel) ? null : `${channel}_credential_unavailable`; }
function assertAutoSendReadiness(db: DatabaseSync, tenantId: string, auto: AdvancedSlaAutoSend): void { if (!auto.stages.length || !auto.channels.length || !auto.risks.length || auto.channels.every((channel) => autoSendDependencyFailure(db, tenantId, channel))) throw new AdvancedSlaInputError('自动发送尚未满足发布就绪条件'); }
function validateAutoSend(value: unknown): AdvancedSlaAutoSend { const input = object(value ?? { enabled: false, stages: [], channels: [], risks: [] }, 'autoSend'); only(input, ['enabled', 'stages', 'channels', 'risks']); const enabled = bool(input.enabled, 'autoSend.enabled'); const policy = { enabled, stages: arrayEnums(input.stages, stages, 'autoSend.stages', !enabled), channels: arrayEnums(input.channels, channels, 'autoSend.channels', !enabled), risks: arrayEnums(input.risks, risks, 'autoSend.risks', !enabled) }; if (enabled && (!policy.stages.length || !policy.channels.length || !policy.risks.length)) throw new AdvancedSlaInputError('启用自动发送必须提供完整允许列表'); return policy; }

const V2_WRITABLE_RULE_FIELDS = ['schemaVersion', 'ruleId', 'name', 'domain', 'companyCode', 'businessUnit', 'stage', 'route', 'risk', 'channel', 'effectiveFrom', 'effectiveTo', 'priority', 'status', 'createdBy', 'approvedBy', 'lastUpdated', 'notes', 'parameters'];
function normalizeV2WritableSections(value: unknown, actorId: string, at: string, existing: AdvancedSlaSectionV2[] = []): AdvancedSlaSectionV2[] {
  if (!Array.isArray(value)) throw new AdvancedSlaInputError('sections 必须为数组');
  const existingRules = new Map(existing.flatMap((section) => section.rules).map((rule) => [rule.ruleId, rule]));
  const generated = value.map((sectionValue, sectionIndex) => {
    const section = object(sectionValue, `sections[${sectionIndex}]`); only(section, ['domain', 'enabled', 'rules']);
    if (!Array.isArray(section.rules)) throw new AdvancedSlaInputError(`sections[${sectionIndex}].rules 必须为数组`);
    return {
      domain: section.domain,
      enabled: bool(section.enabled, `sections[${sectionIndex}].enabled`),
      rules: section.rules.map((ruleValue, ruleIndex) => {
        const writable = object(ruleValue, `sections[${sectionIndex}].rules[${ruleIndex}]`); only(writable, V2_WRITABLE_RULE_FIELDS);
        const previous = typeof writable.ruleId === 'string' ? existingRules.get(writable.ruleId) : undefined;
        const createdBy = typeof writable.createdBy === 'string' && writable.createdBy.trim() && writable.createdBy !== 'pending-server' ? writable.createdBy.trim() : previous?.createdBy ?? actorId;
        const approvedBy = typeof writable.approvedBy === 'string' && writable.approvedBy.trim() ? writable.approvedBy.trim() : null;
        const suppliedUpdated = typeof writable.lastUpdated === 'string' && writable.lastUpdated.trim() ? writable.lastUpdated.trim() : '';
        const lastUpdated = /^\d{4}-\d{2}-\d{2}$/.test(suppliedUpdated) ? `${suppliedUpdated}T00:00:00.000Z` : suppliedUpdated || at;
        return { ...writable, createdBy, approvedBy, lastUpdated };
      }),
    };
  });
  try { return normalizeAdvancedSlaV2Sections(generated); }
  catch (error) { if (error instanceof AdvancedSlaContractError) throw new AdvancedSlaInputError(error.message); throw error; }
}

function legacyUpgradePreview(sections: AdvancedSlaSection[]): { fromSchemaVersion: 1; toSchemaVersion: 2; ready: false; validationResults: AdvancedSlaCsvValidationResult[] } {
  const validationResults = sections.flatMap((section) => section.rules.flatMap((rule) => ['companyCode', 'businessUnit', 'effectiveFrom'].map((field) => ({
    rowNumber: 0, normalizedRuleId: rule.id, severity: 'error' as const, field, code: 'V1_UPGRADE_REQUIRED', message: `${field} is required before this v1 rule can become schema v2`,
  }))));
  return { fromSchemaVersion: 1, toSchemaVersion: 2, ready: false, validationResults };
}

function advancedSlaV2Template(domain: Domain): string {
  const columns = advancedSlaV2CsvColumns(domain);
  return [
    '# Readywork Advanced SLA v2 template',
    '# schema_version=2',
    `# domain=${domain}`,
    '# formats=effective_from/effective_to: YYYY-MM-DD; numbers: decimal; lists: semicolon-separated; booleans: true|false',
    `# enums=stage:${ADVANCED_SLA_STAGES.join('|')}; route:${ADVANCED_SLA_ROUTES.join('|')}; risk:${ADVANCED_SLA_RISKS.join('|')}; channel:${ADVANCED_SLA_CHANNELS.join('|')}; status:draft|active|inactive|retired`,
    columns.join(','),
    '',
  ].join('\n');
}

const V2_FIELD_DEFINITIONS = Object.values(ADVANCED_SLA_V2_PARAMETER_FIELDS).flat();
const V2_LIST_FIELDS = new Set(V2_FIELD_DEFINITIONS.filter((field) => field.kind === 'string_list').map((field) => field.key));
const V2_BOOLEAN_FIELDS = new Set(V2_FIELD_DEFINITIONS.filter((field) => field.kind === 'boolean').map((field) => field.key));
const V2_NUMBER_FIELDS = new Set(['priority', ...V2_FIELD_DEFINITIONS.filter((field) => field.kind === 'number').map((field) => field.key)]);
const V2_OPTIONAL_FIELDS = new Set(V2_FIELD_DEFINITIONS.filter((field) => !field.required).map((field) => field.key));
function snake(value: string): string { return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`); }
function csvV2Value(field: string, raw: string): unknown {
  const value = raw.trim();
  if (V2_LIST_FIELDS.has(field)) return value ? value.split(';').map((item) => item.trim()).filter(Boolean) : [];
  if (field === 'effectiveTo' || field === 'notes' || field === 'lcDetails') return value || null;
  if (!value && V2_OPTIONAL_FIELDS.has(field)) return undefined;
  if (V2_BOOLEAN_FIELDS.has(field)) return value === 'true' ? true : value === 'false' ? false : value;
  if (V2_NUMBER_FIELDS.has(field) || field === 'schemaVersion') return value ? Number(value) : Number.NaN;
  return value;
}

function sectionsFromV2Csv(csv: string, domain: Domain, current: AdvancedSlaSectionV2[], actorId: string, at: string): { sections: AdvancedSlaSectionV2[]; summary: { totalRows: number; validRows: number; invalidRows: number; warnings: number }; validationResults: AdvancedSlaCsvValidationResult[]; candidateHash: string } {
  const dataRows = csv.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n');
  const parsed = Papa.parse<string[]>(dataRows, { skipEmptyLines: 'greedy' });
  if (parsed.errors.length) throw new AdvancedSlaInputError('CSV 格式无效');
  const rows = parsed.data; const headers = rows.shift(); const required = advancedSlaV2CsvColumns(domain);
  if (!headers || headers.length !== required.length || new Set(headers).size !== headers.length || required.some((header, index) => headers[index] !== header)) throw new AdvancedSlaInputError('CSV v2 表头无效');
  const validRules: AdvancedSlaRuleV2[] = []; const validationResults: AdvancedSlaCsvValidationResult[] = [];
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2; const values = Object.fromEntries(required.map((header, column) => [header, row[column] ?? ''])); const normalizedRuleId = values['rule_id']?.trim() || null;
    if (row.length !== required.length || row.some((cell) => /^[=+\-@]/.test(cell.trim()))) { validationResults.push({ rowNumber, normalizedRuleId, severity: 'error', field: 'row', code: 'INVALID_OR_FORMULA_CELL', message: 'CSV row has the wrong column count or a formula-like value' }); continue; }
    const parameterFields = ADVANCED_SLA_V2_PARAMETER_FIELDS[domain];
    const rule = {
      schemaVersion: csvV2Value('schemaVersion', values['schema_version']!), ruleId: values['rule_id'], name: values['name'], domain: values['domain'], companyCode: values['company_code'], businessUnit: values['business_unit'],
      stage: values['stage'], route: values['route'], risk: values['risk'], channel: values['channel'], effectiveFrom: values['effective_from'], effectiveTo: csvV2Value('effectiveTo', values['effective_to']!),
      priority: csvV2Value('priority', values['priority']!), status: values['status'], createdBy: actorId, approvedBy: null, lastUpdated: at, notes: csvV2Value('notes', values['notes']!),
      parameters: { domain, ...Object.fromEntries(parameterFields.map((field) => [field.key, csvV2Value(field.key, values[snake(field.key)] ?? '')]).filter(([, value]) => value !== undefined)) },
    };
    const result = advancedSlaRuleV2Schema.safeParse(rule);
    if (result.success) validRules.push(result.data as AdvancedSlaRuleV2);
    else for (const issue of result.error.issues) validationResults.push({ rowNumber, normalizedRuleId, severity: 'error', field: issue.path.join('.') || 'row', code: `INVALID_${String(issue.code).toUpperCase()}`, message: issue.message });
  }
  const candidate = current.map((section) => section.domain === domain ? { ...section, rules: validRules } : section);
  let sections: AdvancedSlaSectionV2[];
  try { sections = normalizeAdvancedSlaV2Sections(candidate); }
  catch (error) { throw new AdvancedSlaInputError(error instanceof Error ? error.message : 'CSV candidate graph is invalid'); }
  const invalidRows = new Set(validationResults.filter((item) => item.severity === 'error').map((item) => item.rowNumber)).size;
  const summary = { totalRows: rows.length, validRows: validRules.length, invalidRows, warnings: validationResults.filter((item) => item.severity === 'warning').length };
  return { sections, summary, validationResults, candidateHash: digest(JSON.stringify(sections)) };
}

function sectionsFromCsv(csv: string): AdvancedSlaSection[] { const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: 'greedy' }); if (parsed.errors.length) throw new AdvancedSlaInputError('CSV 格式无效'); const rows = parsed.data; const headers = rows.shift(); const required = ['domain', 'rule_id', 'name', 'enabled', 'scope_json', 'parameters_json']; if (!headers || headers.length !== required.length || new Set(headers).size !== headers.length || required.some((header, index) => headers[index] !== header)) throw new AdvancedSlaInputError('CSV 表头无效'); const grouped = new Map<Domain, AdvancedSlaRule[]>(); for (const row of rows) { if (row.length !== required.length || row.some((cell) => /^[=+\-@]/.test(cell.trim()))) throw new AdvancedSlaInputError('CSV 行无效或包含公式'); let scope: unknown; let parameters: unknown; try { scope = JSON.parse(row[4]!); parameters = JSON.parse(row[5]!); } catch { throw new AdvancedSlaInputError('CSV JSON 无效'); } const domain = enumeration(row[0], ADVANCED_SLA_DOMAINS, 'domain'); const existing = grouped.get(domain) ?? []; existing.push({ id: row[1]!, name: row[2]!, enabled: csvBoolean(row[3]!), scope: scope as AdvancedSlaRule['scope'], parameters: parameters as AdvancedSlaRule['parameters'] }); grouped.set(domain, existing); } if (ADVANCED_SLA_DOMAINS.some((domain) => !grouped.has(domain))) throw new AdvancedSlaInputError('CSV 必须覆盖全部九个领域'); return validateAdvancedSlaSections(ADVANCED_SLA_DOMAINS.map((domain) => ({ domain, enabled: true, rules: grouped.get(domain) ?? [] }))); }
function countRules(sections: readonly { rules: readonly unknown[] }[]): number { return sections.reduce((total, section) => total + section.rules.length, 0); }
function diff(oldSections: AdvancedSlaSection[], nextSections: AdvancedSlaSection[]): Record<string, number> { const oldRules = new Map(oldSections.flatMap((section) => section.rules).map((rule) => [rule.id, JSON.stringify(rule)])); const nextRules = new Map(nextSections.flatMap((section) => section.rules).map((rule) => [rule.id, JSON.stringify(rule)])); let added = 0; let changed = 0; let unchanged = 0; for (const [id, rule] of nextRules) { const previous = oldRules.get(id); if (!previous) added += 1; else if (previous === rule) unchanged += 1; else changed += 1; } return { added, changed, removed: [...oldRules.keys()].filter((id) => !nextRules.has(id)).length, unchanged }; }
function getProfile(db: DatabaseSync, tenantId: string, id: string): ProfileRow | undefined { return db.prepare('SELECT * FROM procurement_advanced_sla_profiles WHERE tenant_id=? AND id=?').get(tenantId, id) as ProfileRow | undefined; }
function requiredProfile(db: DatabaseSync, tenantId: string, id: string): ProfileRow { const row = getProfile(db, tenantId, id); if (!row) throw new NotFoundError('Advanced SLA 配置不存在'); return row; }
function getBatch(db: DatabaseSync, tenantId: string, id: string): BatchRow | undefined { return db.prepare('SELECT * FROM procurement_advanced_sla_import_batches WHERE tenant_id=? AND id=?').get(tenantId, id) as BatchRow | undefined; }
function runtimeControl(db: DatabaseSync, tenantId: string, profileId: string): { profileId: string; profileVersion: number; paused: boolean; version: number; updatedBy: string; updatedAt: string } | null { const row = db.prepare('SELECT * FROM procurement_advanced_sla_runtime_controls WHERE tenant_id=? AND profile_id=?').get(tenantId, profileId) as RuntimeRow | undefined; return row ? { profileId: row.profile_id, profileVersion: row.profile_version, paused: Boolean(row.paused), version: row.version, updatedBy: row.updated_by, updatedAt: row.updated_at } : null; }
function presentProfile(row: ProfileRow) {
  const schemaVersion = row.schema_version === 2 ? 2 : 1;
  const sections = schemaVersion === 2 ? normalizeAdvancedSlaV2Sections(safe(row.sections_json)) : validateAdvancedSlaSections(safe(row.sections_json));
  return { id: row.id, name: row.name, description: row.description, status: row.status, version: row.version, schemaVersion, sections, autoSend: parseAuto(row), createdBy: row.created_by, updatedBy: row.updated_by, publishedBy: row.published_by, createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at, ...(schemaVersion === 1 ? { upgradePreview: legacyUpgradePreview(sections as AdvancedSlaSection[]) } : {}) };
}
function parseAuto(row: ProfileRow): AdvancedSlaAutoSend { return validateAutoSend(safe(row.auto_send_json)); }
function presentBatch(row: BatchRow, impactPreview?: AdvancedSlaImpactPreview) { const error = row.error_json ? safe(row.error_json) : null; const sections = error ? [] : row.schema_version === 2 ? normalizeAdvancedSlaV2Sections(safe(row.sections_json)) : validateAdvancedSlaSections(safe(row.sections_json)); return { id: row.id, profileId: row.profile_id, profileVersion: row.profile_version, version: row.version, sourceName: row.source_name, status: error ? 'failed' : row.status, schemaVersion: row.schema_version, templateVersion: row.template_version, domain: row.domain, sourceSha256: row.source_sha256, candidateHash: row.candidate_hash, totalCount: row.total_count, validCount: row.valid_count, invalidCount: row.invalid_count, warningCount: row.warning_count, validationResults: safe(row.validation_results_json), validatedAt: row.validated_at, sections, summary: safe(row.summary_json), diff: safe(row.summary_json), error, createdBy: row.created_by, appliedBy: row.applied_by, createdAt: row.created_at, updatedAt: row.updated_at || row.created_at, appliedAt: row.applied_at, ...(impactPreview ? { impactPreview } : {}) }; }
function insertImportBatch(db: DatabaseSync, input: { tenantId: string; id: string; profileId: string; profileVersion: number; sourceName: string; payloadHash: string; sections: AdvancedSlaSection[] | AdvancedSlaSectionV2[]; summary: Record<string, number>; error: Record<string, unknown> | null; actorId: string; at: string; templateVersion?: number; schemaVersion?: number; domain?: string; sourceSha256?: string; candidateHash?: string; validationResults?: AdvancedSlaCsvValidationResult[]; totalCount?: number; validCount?: number; invalidCount?: number; warningCount?: number; validatedAt?: string | null }): void {
  db.prepare(`INSERT INTO procurement_advanced_sla_import_batches
    (tenant_id,id,profile_id,profile_version,version,source_name,payload_hash,sections_json,summary_json,status,error_json,created_by,created_at,updated_at,template_version,schema_version,domain,source_sha256,total_count,valid_count,invalid_count,warning_count,candidate_hash,validation_results_json,validated_at)
    VALUES (?,?,?,?,1,?,?,?,?,'previewed',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.tenantId, input.id, input.profileId, input.profileVersion, input.sourceName, input.payloadHash,
    JSON.stringify(input.sections), JSON.stringify(input.summary), input.error ? JSON.stringify(input.error) : null, input.actorId, input.at, input.at,
    input.templateVersion ?? 1, input.schemaVersion ?? 1, input.domain ?? 'global', input.sourceSha256 ?? digest(input.payloadHash), input.totalCount ?? 0,
    input.validCount ?? 0, input.invalidCount ?? 0, input.warningCount ?? 0, input.candidateHash ?? digest(JSON.stringify(input.sections)), JSON.stringify(input.validationResults ?? []), input.validatedAt ?? null,
  );
}
function retirePrevious(db: DatabaseSync, tenantId: string, actor: string, at: string): void { const previous = db.prepare("SELECT id,version,schema_version,sections_json FROM procurement_advanced_sla_profiles WHERE tenant_id=? AND status='published'").get(tenantId) as { id: string; version: number; schema_version: number; sections_json: string } | undefined; if (!previous) return; db.prepare("UPDATE procurement_advanced_sla_profiles SET status='retired',version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND id=? AND status='published'").run(actor, at, tenantId, previous.id); profileEvent(db, tenantId, previous.id, actor, 'retired_by_new_publication', { version: previous.version + 1, schemaVersion: previous.schema_version, status: 'retired', ruleCount: countRules(safe(previous.sections_json) as Array<{ rules: unknown[] }>), source: 'replacement_publication', diffSummary: { statusChanged: 1 } }, at); }
function profileEvent(db: DatabaseSync, tenantId: string, profileId: string, actor: string, action: string, detail: unknown, at: string): void { db.prepare('INSERT INTO procurement_advanced_sla_profile_events (tenant_id,id,profile_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)').run(tenantId, `advanced-sla-event:${randomUUID()}`, profileId, actor, action, JSON.stringify(detail), at); }
function runtimeEvent(db: DatabaseSync, tenantId: string, profileId: string, profileVersion: number, actor: string, action: string, detail: unknown, at: string): void { db.prepare('INSERT INTO procurement_advanced_sla_runtime_events (tenant_id,id,profile_id,profile_version,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run(tenantId, `advanced-sla-runtime:${randomUUID()}`, profileId, profileVersion, actor, action, JSON.stringify(detail), at); }
function tx(db: DatabaseSync, fn: () => void): void { db.exec('BEGIN IMMEDIATE'); try { fn(); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; } }
function json(req: IncomingMessage): Promise<Record<string, unknown>> { return new Promise(async (resolve, reject) => { let raw = ''; try { for await (const chunk of req) { raw += String(chunk); if (raw.length > 600_000) throw new AdvancedSlaInputError('请求过大'); } const value = JSON.parse(raw || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdvancedSlaInputError('请求体必须为对象'); resolve(value as Record<string, unknown>); } catch (error) { reject(error instanceof AdvancedSlaInputError ? error : new AdvancedSlaInputError('请求体 JSON 无效')); } }); }
function object(value: unknown, field: string): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdvancedSlaInputError(`${field} 必须为对象`); return value as Record<string, any>; }
function only(value: Record<string, unknown>, allowed: string[]): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new AdvancedSlaInputError(`不允许的字段: ${key}`); }
function text(value: unknown, field: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new AdvancedSlaInputError(`${field} 无效`); return value.trim(); }
function optionalText(value: unknown, field: string, max: number): string { if (value === undefined || value === null) return ''; if (typeof value !== 'string' || value.trim().length > max) throw new AdvancedSlaInputError(`${field} 无效`); return value.trim(); }
function bool(value: unknown, field: string): boolean { if (typeof value !== 'boolean') throw new AdvancedSlaInputError(`${field} 必须为布尔值`); return value; }
function csvBoolean(value: string): boolean { const normalized = value.trim(); if (normalized === 'true') return true; if (normalized === 'false') return false; throw new AdvancedSlaInputError('CSV enabled 必须为 true 或 false'); }
function positive(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AdvancedSlaInputError(`${field} 必须为正整数`); return Number(value); }
function enumeration<T extends string>(value: unknown, allowed: readonly T[], field: string): T { if (typeof value !== 'string' || !allowed.includes(value as T)) throw new AdvancedSlaInputError(`${field} 无效`); return value as T; }
function arrayEnums<T extends string>(value: unknown, allowed: readonly T[], field: string, allowEmpty = false): T[] { if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new AdvancedSlaInputError(`${field} 不能为空`); const entries = value.map((item) => enumeration(item, allowed, field)); if (new Set(entries).size !== entries.length) throw new AdvancedSlaInputError(`${field} 不可重复`); return entries; }
function pathId(value: string): string { try { return text(decodeURIComponent(value), 'id', 300); } catch { throw new AdvancedSlaInputError('路径 ID 无效'); } }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function sha256(value: unknown, field: string): string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new AdvancedSlaInputError(`${field} 必须为小写 SHA-256`); return value; }
function safe(value: string): any { try { return JSON.parse(value); } catch { return {}; } }
function send(res: ServerResponse, status: number, body: unknown): true { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); return true; }
function sendCsv(res: ServerResponse, csv: string, filename: string): true { res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store' }); res.end(csv); return true; }
function forbidden(res: ServerResponse): true { return send(res, 403, { error: '需要采购配置与审批权限', code: 'FORBIDDEN' }); }
function failure(res: ServerResponse, error: unknown): true { if (error instanceof VersionError) return send(res, 409, { error: error.message, code: 'ADVANCED_SLA_VERSION_CONFLICT', currentVersion: error.currentVersion }); if (error instanceof StateError || error instanceof ConflictError) return send(res, 409, { error: error.message, code: 'ADVANCED_SLA_STATE_CONFLICT' }); if (error instanceof NotFoundError) return send(res, 404, { error: error.message, code: 'ADVANCED_SLA_NOT_FOUND' }); if (error instanceof V2RequiredError) return send(res, 422, { error: error.message, code: 'ADVANCED_SLA_V2_REQUIRED' }); if (error instanceof AdvancedSlaInputError) return send(res, 422, { error: error.message, code: 'INVALID_ADVANCED_SLA_INPUT' }); throw error; }
class AdvancedSlaInputError extends Error {} class V2RequiredError extends Error {} class VersionError extends Error { constructor(readonly currentVersion: number) { super(`版本冲突，当前版本为 ${currentVersion}`); } } class StateError extends Error {} class ConflictError extends Error {} class NotFoundError extends Error {}
