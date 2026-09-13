import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AIEmployee, EmployeeDefinition, EmployeePackManifest, EmployeeSpec, EmployeeVersion, Task } from '@readywork/core';
import { CORE_WORKFORCE_EMPLOYEE_PACK, EmployeePackRegistry, emptyStats, nowIso, uid, APPROVAL_THRESHOLDS, approvalLevel, EXCEPTION_TYPES } from '@readywork/core';
import { ConnectorRegistry, createStubConnectors, NetEaseMailConnector } from '@readywork/connectors';
import { createImapReceivePort } from './messaging/email-adapter.js';
import { createDurableInboundMailHandler } from './messaging/inbound-mail-handler.js';
import type { InboundEmail } from '@readywork/connectors';
import {
  attachPersistence,
  createPersistentRuntimeHub,
  openPersistence,
  persistOrg,
  ProcurementValidationError,
  restoreOrgState,
} from '@readywork/persistence';
import {
  can,
  clearSessionCookieHeader,
  createPublicDemoSession,
  demoAuthEnabled,
  localDemoSession,
  login,
  logout,
  resolveSession,
  sessionCookieHeader,
  sessionTokenFromCookie,
  type PlatformPermission,
  type Session,
} from './auth.js';
import { assertPublicDemoConfiguration, publicDemoCapabilityDenied, publicDemoMode } from './public-demo-mode.js';
import { createChatHandler } from './chat.js';
import { EditorIdempotencyConflictError, EditorRevisionConflictError, EditorRevisionRequiredError, EditorStore, type EditorNodeRun, type EditorRun, type EditorRunMode, type EditorWorkflowDef } from './editor.js';
import { EditorStoreRegistry } from './editor-registry.js';
import { ActionGateway } from './action-gateway.js';
import { ConnectorControlPlaneRegistry } from './connector-control-plane.js';
import { claimEditorApprovalDecision, existingEditorApprovalDecision, markEditorApprovalDecisionFailed, markEditorApprovalDecisionSent, prepareEditorApprovalSignal, temporalStateRecordedApproval } from './editor-approval.js';
import { preflightExceptionApproval } from './exception-approval.js';
import { surfaceAllows, type ApiSurface } from './service-surface.js';
import { TemporalRuntimeClient, type TemporalWorkflowVersion } from '@readywork/temporal-runtime';
import {
  TENANT_ID,
  createSupplyChainRuntime,
  syncObjectToContext,
  ProcurementOrchestrator,
  PROCUREMENT_EMPLOYEE_PACK,
} from '@readywork/supply-chain';
import type { SupplyChainRuntime } from '@readywork/supply-chain';
import { describeTemporalWorkerRuntime } from './agent-runtime-status.js';
import { HttpError, publicIntegrationError, redactSensitive } from './http-errors.js';
import { handleRequisitionRequest } from './requisitions.js';
import { processSignedProcurementWebhook } from './procurement-webhook.js';
import { processWhatsAppWebhook, verifyWhatsAppWebhookSubscription } from './procurement-whatsapp-webhook.js';
import { handleProcurementRfqRequest } from './procurement-rfqs.js';
import { handleProcurementWorkbenchRequest } from './procurement-workbench.js';
import { handleProcurementPoChatRequest } from './procurement-po-chat.js';
import { handleProcurementRouteChatRequest } from './procurement-route-chat.js';
import { handleProcurementRealtimeEventsRequest } from './procurement-realtime-events.js';
import { handleProcurementRiskDashboardRequest } from './procurement-risk-dashboard.js';
import { handleProcurementSupplierPerformanceRequest } from './procurement-supplier-performance.js';
import { handleProcurementSlaRequest } from './procurement-sla.js';
import { handleProcurementAdvancedSlaRequest } from './procurement-advanced-sla.js';
import { ProcurementSlaAutomationWorker, handleProcurementSlaAutomationRequest } from './procurement-sla-automation.js';
import { handleProcurementImportDocumentRequest } from './procurement-import-documents.js';
import { handleProcurementExecutionRequest } from './procurement-execution.js';
import { handleProcurementMessageDraftRequest } from './procurement-message-drafts.js';
import { handleProcurementCommunicationIdentityRequest } from './procurement-communication-identity.js';
import { handleProcurementConfigurationConnectionsRequest } from './procurement-configuration-connections.js';
import { handleProcurementDeploymentProfileRequest } from './procurement-deployment-profile.js';
import { handleProcurementTenantPreferencesRequest } from './procurement-tenant-preferences.js';
import { handleProcurementLeadTimeRequest } from './procurement-lead-times.js';
import { handleProcurementNotificationRequest, ProcurementNotificationWorker } from './procurement-notifications.js';
import { handleProcurementGlobalSearchRequest } from './procurement-global-search.js';
import { handleProcurementRouteRequest } from './procurement-routes.js';
import { handleProcurementRouteExportRequest } from './procurement-route-exports.js';
import { handleProcurementPoDocumentRequest } from './procurement-po-documents.js';
import { handleProcurementPoIntakeRequest, persistInboundEmailAttachments } from './procurement-po-intake.js';
import { InboundPurchaseOrderEmailError, resolvePurchaseOrderNumberFromEmailThread } from './procurement-inbound-email.js';
import { ingestInboundPurchaseOrderEmailWithAi, handleAiReplyRequest } from './procurement-ai-reply.js';
import {
  deferredInboundMailUids,
  handleProcurementInboundMailRequest,
  inboundMailAutomaticPollIntervalMs,
  runAutomaticInboundMailPollIfDue,
  recordInboundMailRuntimeState,
  recordInboundMailRejection,
  rejectedInboundMailUids,
  resolveInboundMailRejection,
  runInboundMailPoll,
  type ProcurementInboundMailPollResult,
} from './procurement-inbound-mail-monitor.js';
import { handleOdooProcurementSyncRequest } from './odoo-procurement-sync.js';
import { OdooRuntimeResolver } from './odoo-runtime-resolver.js';
import { CollaborationControlPlane, type CollaborationAction } from './collaboration-channels.js';
import { listSecurityEvents, listSecurityIncidents, observedMalwareScannerHealth, productionReadiness, recordSecurityEvent, resolveSecurityEvent, resolveSecurityIncident, resolveSupplierEmailIdentityIncidentsAfterSuccessfulIngest, resolveSupplierEmailIdentityIncidentsForMailboxSelfSender, securityIncidentSummary, SecurityEventResolutionError } from './production-operations.js';
import { procurementV1ReadinessForOperations } from './manufacturing-context-readiness.js';
import { ProcurementOutboxWorker } from './procurement-outbox-worker.js';
import { MessagingRuntimeRegistry } from './messaging/runtime.js';
import { resolveEmailTransportMode } from './messaging/email-transport-mode.js';
import { ProcurementMessagingBridge } from './messaging/procurement-bridge.js';
import { handleMessagingRequest } from './messaging-routes.js';
import { HermesControlClient } from './messaging/hermes-control-client.js';
import { handleHermesMessagingRequest } from './messaging/hermes-routes.js';
import { handleHermesIntegrationRequest } from './messaging/hermes-bridge.js';
import { ProcurementDocumentWorker } from './procurement-document-worker.js';
import { isClamAvConfigured } from './procurement-malware-scanner.js';
import { loadAttachmentObjectStorageConfig, S3AttachmentObjectStorage } from './attachment-object-storage.js';
import { TeamsBotFrameworkAdapter, listTeamsConversationReferences, upsertTeamsIdentityBinding, type BotFrameworkActivity, type TeamsBotConfiguration } from './teams-bot-adapter.js';
import { reconcileTemporalRun, reconcileTemporalRuns } from './temporal-run-reconciliation.js';
import { createManufacturingContextRuntime } from './manufacturing-context-worker.js';
import { handleManufacturingContextRequest } from './manufacturing-context-routes.js';
import { submitPublicDemoRequest } from './public-demo-requests.js';
import { PublicDemoResetInProgressError, readPublicDemoStatus, resetPublicDemo } from './public-demo-reset.js';

/**
 * AI Workforce OS · Console 后端 API（node:http 零依赖，供 apps/console 前端调用）。
 * 员工优先的 REST 契约：员工详情（Workers/Workflows/Skills/Tools/Policies）+ 任务 + 审批 + 事件。
 */

const SERVICE_SURFACE = (process.env['READYWORK_API_SURFACE'] ?? 'compat') as ApiSurface;
const PORT = Number(process.env['PORT'] ?? (SERVICE_SURFACE === 'control' ? 4174 : 4173));
const HOST = process.env['READYWORK_API_HOST'] ?? '127.0.0.1';
const ALLOWED_ORIGINS = new Set(
  (process.env['READYWORK_ALLOWED_ORIGINS'] ?? 'http://127.0.0.1:3001,http://localhost:3001')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);
const INTERNAL_CALLBACK_TOKEN = process.env['READYWORK_INTERNAL_CALLBACK_TOKEN'] ?? randomBytes(32).toString('hex');
assertPublicDemoConfiguration();
const temporalRuntime = new TemporalRuntimeClient();

const mailConnector = new NetEaseMailConnector();
const connectors = new ConnectorRegistry();
for (const c of createStubConnectors()) connectors.register(c.id === 'netease-mail' ? mailConnector : c);

// 持久化：默认落盘 node:sqlite（DB_PATH 可覆盖；MEMORY=1 强制内存）
const useMemory = process.env['MEMORY'] === '1';
const dbPath = useMemory ? '' : process.env['DB_PATH'] ?? resolve(process.cwd(), 'data/readywork.sqlite');

/**
 * 本地开发默认把凭据主密钥保存在数据库同目录的 0600 文件中，避免每次重启
 * 都无法解密 Connector 凭据。生产环境仍然必须显式提供环境变量或密钥文件。
 */
function configureCredentialKey(): void {
  if (process.env['READYWORK_CREDENTIAL_KEY'] || useMemory) return;
  const configuredFile = process.env['READYWORK_CREDENTIAL_KEY_FILE'];
  if (!configuredFile && process.env['NODE_ENV'] === 'production') return;
  const keyFile = configuredFile ?? resolve(dirname(dbPath), '.readywork-credential-key');
  mkdirSync(dirname(keyFile), { recursive: true });
  const load = (): string | undefined => {
    try {
      const key = readFileSync(keyFile, 'utf8').trim();
      return key.length >= 24 ? key : undefined;
    } catch {
      return undefined;
    }
  };
  let key = load();
  if (!key) {
    const candidate = randomBytes(32).toString('base64url');
    try {
      writeFileSync(keyFile, `${candidate}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      key = candidate;
    } catch {
      key = load();
    }
  }
  if (!key) return;
  try { chmodSync(keyFile, 0o600); } catch { /* fail closed later if the key is unusable */ }
  process.env['READYWORK_CREDENTIAL_KEY'] = key;
}

configureCredentialKey();
const store = dbPath ? openPersistenceWithDir(dbPath) : undefined;
const requisitionMemoryStore = store ? undefined : openPersistence(':memory:');
const requisitionDb = store?.db ?? requisitionMemoryStore!.db;

// Business ERP access is resolved for the request/outbox tenant, never from a
// process-startup tenant or environment-wide singleton.
const odooRuntimeResolver = new OdooRuntimeResolver(store?.db);

const hub0 = store ? createPersistentRuntimeHub(store, { normalizeInterrupted: SERVICE_SURFACE !== 'control' }) : undefined;

function syncThresholdToEditor(scopedEditorStore: EditorStore, kind: string, auto: number, buyer: number): void {
  const nextRules = kind === 'threeWayVariancePct'
    ? [
        { cond: `差异 ≤ ${auto}%`, action: '自动通过', level: 'auto' as const },
        { cond: `差异 ${auto}–${buyer}%`, action: '财务审批', level: 'finance' as const },
        { cond: `差异 > ${buyer}%`, action: '采购+财务审批', level: 'manager' as const },
      ]
    : kind === 'deliveryDelayDays'
      ? [
          { cond: `延期 ≤ ${auto} 天`, action: '自动接受', level: 'auto' as const },
          { cond: `延期 ${auto}–${buyer} 天`, action: '采购员审批', level: 'buyer' as const },
          { cond: `延期 > ${buyer} 天`, action: '采购经理审批', level: 'manager' as const },
        ]
      : undefined;
  if (!nextRules) return;
  for (const workflow of scopedEditorStore.listWorkflows()) {
    let changed = false;
    const nodes = workflow.nodes.map((editorNode) => {
      const matches = kind === 'threeWayVariancePct'
        ? editorNode.label.includes('三单匹配')
        : editorNode.label.includes('交期异常') || editorNode.label.includes('延期判断');
      if (!matches || JSON.stringify(editorNode.rules ?? []) === JSON.stringify(nextRules)) return editorNode;
      changed = true;
      return { ...editorNode, rules: nextRules };
    });
    if (changed) scopedEditorStore.saveWorkflow(workflow.id, { ...workflow, nodes, expectedRevision: workflow.draftRevision });
  }
}

// 员工运行时挂真实邮件发送器 + 真实 Odoo 后端 + 持久化仓储
const rt = createSupplyChainRuntime({ hub: hub0, mailer: mailConnector });
const { hub, engine, tower, employees, humans } = rt;
const employeePacks = new EmployeePackRegistry([PROCUREMENT_EMPLOYEE_PACK, CORE_WORKFORCE_EMPLOYEE_PACK]);

function capabilityPackIdsForSpec(spec: EmployeeSpec | undefined): string[] {
  return spec?.capabilityPackIds?.length ? [...spec.capabilityPackIds] : [CORE_WORKFORCE_EMPLOYEE_PACK.id];
}

function capabilityPackIdsForEmployee(employeeId: string): string[] {
  const employee = hub.org.getAI(employeeId);
  return capabilityPackIdsForSpec(employee ? hub.specs.get(employee.specId) : undefined);
}

const editorStores = new EditorStoreRegistry(store?.db, ({ employeeId }) => capabilityPackIdsForEmployee(employeeId));
const procurementEditorStore = editorStores.forScope({ tenantId: TENANT_ID, employeeId: employees.procurement.id });
const activeRuleSet = procurementEditorStore.currentRuleSet();
if (activeRuleSet) {
  for (const [kind, threshold] of Object.entries(activeRuleSet.thresholds)) APPROVAL_THRESHOLDS[kind] = { ...threshold };
}

/**
 * 对外只暴露 AI Runtime 的能力状态，不暴露任何凭据值。
 * 这里描述的是 Temporal Worker 将采用的 AI Runtime 配置目标；
 * Worker 不由控制面进程托管，因此未观测到实际 poller 时不会显示为已就绪。
 */
const agentRuntimeStatus = (workerObserved: boolean) => describeTemporalWorkerRuntime(process.env, { workerObserved });

const connectorControlPlanes = new ConnectorControlPlaneRegistry(store?.db, rt.tools);
const hermesDashboardUrl = process.env['READYWORK_HERMES_DASHBOARD_URL'] ?? 'http://127.0.0.1:9119';
const hermesBridgeUrl = process.env['READYWORK_HERMES_BRIDGE_URL'] ?? 'http://127.0.0.1:8788';
const hermesBridgeSecret = process.env['READYWORK_HERMES_BRIDGE_SECRET'] ?? '';
const emailTransportMode = resolveEmailTransportMode(process.env);
const messagingRuntimes = store?.db ? new MessagingRuntimeRegistry(
  store.db,
  (tenantId) => connectorControlPlanes.forTenant(tenantId),
  {
    ...(hermesBridgeSecret ? { hermesBridge: { baseUrl: hermesBridgeUrl, secret: hermesBridgeSecret } } : {}),
    emailTransportMode,
  },
) : undefined;
const hermesControl = process.env['READYWORK_HERMES_DASHBOARD_TOKEN']
  ? new HermesControlClient({
      baseUrl: hermesDashboardUrl,
      weixinOnboardingUrl: process.env['READYWORK_HERMES_WEIXIN_ONBOARDING_URL'] ?? 'http://127.0.0.1:9121',
      token: async () => process.env['READYWORK_HERMES_DASHBOARD_TOKEN'] ?? '',
    })
  : undefined;
const actionGateway = new ActionGateway(store?.db, hub, rt.context, connectorControlPlanes);
const attachmentObjectStorageConfig = loadAttachmentObjectStorageConfig();
const attachmentObjectStorage = attachmentObjectStorageConfig ? new S3AttachmentObjectStorage(attachmentObjectStorageConfig) : undefined;
const procurementOutboxWorker = store?.db ? new ProcurementOutboxWorker(
  store.db,
  (tenantId) => connectorControlPlanes.forTenant(tenantId),
  {
    ...(attachmentObjectStorage ? { objectStorage: attachmentObjectStorage } : {}),
    odooRuntimeResolver,
    ...(messagingRuntimes ? { messageGatewayForTenant: (tenantId: string) => messagingRuntimes.forTenant(tenantId) } : {}),
  },
) : undefined;
const procurementDocumentWorker = store?.db ? new ProcurementDocumentWorker(
  store.db,
  { ...(attachmentObjectStorage ? { objectStorage: attachmentObjectStorage } : {}) },
) : undefined;
const configuredSlaIntervalSeconds = Number(process.env['READYWORK_SLA_INTERVAL_SECONDS'] ?? 300);
const procurementSlaAutomationWorker = store?.db ? new ProcurementSlaAutomationWorker(
  store.db,
  { intervalSeconds: Number.isSafeInteger(configuredSlaIntervalSeconds) ? configuredSlaIntervalSeconds : 300 },
) : undefined;
const procurementNotificationWorker = store?.db ? new ProcurementNotificationWorker(store.db) : undefined;
const manufacturingContextRuntime = createManufacturingContextRuntime({
  surface: SERVICE_SURFACE,
  db: requisitionDb,
  workerId: `manufacturing-context:${process.pid}`,
  now: nowIso,
});
if (store && hub0) {
  persistOrg(store, hub0);
  attachPersistence(store, hub0);
  restoreOrgState(store, hub0);
}

// 重启后恢复 ERP 工具的内存态（rfq/po 从持久化业务对象重建）：
// 保证「等待审批 → 重启 → 批准恢复执行」时，rfq.award / po.update 等工具不因内存态丢失而失败。
{
  const erp = rt.tools.get('erp') as {
    rfqs?: Map<string, Record<string, unknown>>;
    pos?: Map<string, Record<string, unknown>>;
    requisitions?: Map<string, Record<string, unknown>>;
  } | undefined;
  if (erp) {
    for (const bo of hub.objects.list()) {
      if (bo.type === 'rfq' && erp.rfqs && !erp.rfqs.has(bo.id)) {
        erp.rfqs.set(bo.id, {
          id: bo.id,
          item: bo.attributes['item'],
          qty: bo.attributes['qty'],
          suppliers: String(bo.attributes['suppliers'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          quotes: [],
          status: bo.status === 'awarded' ? 'awarded' : 'open',
          createdAt: bo.updatedAt,
        });
      }
      if (bo.type === 'po' && erp.pos && !erp.pos.has(bo.id)) {
        erp.pos.set(bo.id, {
          id: bo.id,
          item: bo.attributes['item'],
          qty: bo.attributes['qty'],
          unitPrice: bo.attributes['unitPrice'],
          promiseDate: bo.attributes['promiseDate'],
          supplierName: bo.attributes['supplierName'],
          status: bo.attributes['status'] ?? bo.status,
        });
      }
    }
  }
}

const deployModes = new Map<string, 'shadow' | 'supervised' | 'autonomous'>();

function publishEmployeeSnapshot(employee: AIEmployee, spec: EmployeeSpec, mode: 'shadow' | 'supervised' | 'autonomous', version = spec.version): void {
  if (!store) return;
  const now = nowIso();
  const current = store.workforce.getDefinition(employee.id);
  const definition: EmployeeDefinition = {
    id: employee.id,
    tenantId: employee.tenantId,
    name: employee.name,
    role: employee.role,
    departmentId: employee.deptId,
    managerId: employee.managerId,
    capabilityPackIds: capabilityPackIdsForSpec(spec),
    createdAt: current?.createdAt ?? employee.createdAt,
    updatedAt: now,
  };
  const versionId = `${employee.id}:version:${version}`;
  const employeeVersion: EmployeeVersion = {
    id: versionId,
    tenantId: employee.tenantId,
    employeeId: employee.id,
    version,
    // 旧 Spec 的 when/handler 是运行时函数；员工版本只持久化可发布的声明部分。
    spec: JSON.parse(JSON.stringify(spec)) as EmployeeSpec,
    capabilityPackIds: definition.capabilityPackIds,
    workflowIds: [...spec.workflows],
    connectorGrantIds: [...spec.tools],
    createdAt: now,
  };
  store.workforce.saveVersion(employeeVersion);
  store.workforce.saveDefinition(definition, versionId);
  store.workforce.saveDeployment({
    tenantId: employee.tenantId,
    employeeId: employee.id,
    versionId,
    deployMode: mode,
    connectorGrantIds: [...spec.tools],
    updatedAt: now,
  });
}

for (const employee of hub.org.listAI()) {
  const deployment = store?.workforce.getDeployment(employee.id);
  const mode = deployment?.deployMode ?? 'supervised';
  deployModes.set(employee.id, mode);
  const spec = hub.specs.get(employee.specId);
  if (spec && !store?.workforce.getDefinition(employee.id)) publishEmployeeSnapshot(employee, spec, mode);
}

let employeeSeq = 0;
let specSeq = 0;

const collaborationSigningSecret = process.env['READYWORK_COLLABORATION_SIGNING_SECRET']
  ?? (process.env['NODE_ENV'] === 'production' ? undefined : 'readywork-local-collaboration-signing-secret');
const teamsAllowedHumanIds = (process.env['READYWORK_TEAMS_ALLOWED_HUMAN_IDS'] ?? '')
  .split(',').map((item) => item.trim()).filter(Boolean);
const teamsBotConfig: TeamsBotConfiguration | undefined = process.env['READYWORK_TEAMS_APP_ID'] ? {
  appId: process.env['READYWORK_TEAMS_APP_ID'],
  ...(process.env['READYWORK_TEAMS_APP_SECRET'] ? { appSecret: process.env['READYWORK_TEAMS_APP_SECRET'] } : {}),
  issuer: process.env['READYWORK_TEAMS_JWT_ISSUER'] ?? 'https://api.botframework.com',
  jwksUrl: process.env['READYWORK_TEAMS_JWKS_URL'] ?? 'https://login.botframework.com/v1/.well-known/keys',
  ...(process.env['READYWORK_TEAMS_OAUTH_TOKEN_URL'] ? { oauthTokenUrl: process.env['READYWORK_TEAMS_OAUTH_TOKEN_URL'] } : {}),
  ...(process.env['READYWORK_TEAMS_SERVICE_HOSTS'] ? { allowedServiceUrlHosts: process.env['READYWORK_TEAMS_SERVICE_HOSTS'].split(',').map((item) => item.trim()).filter(Boolean) } : {}),
} : undefined;
const collaboration = collaborationSigningSecret ? new CollaborationControlPlane({
  tasks: { list: () => hub.machine.list(), get: (taskId) => hub.machine.get(taskId) },
  approvals: { listByTask: (taskId) => hub.approvals.listByTask(taskId) },
  signingSecret: collaborationSigningSecret,
  teams: (tenantId) => teamsBotConfig
    ? { tenantId, enabled: true, ...(teamsAllowedHumanIds.length ? { allowedHumanIds: teamsAllowedHumanIds } : {}) }
    : undefined,
  onCommitted: (commit) => {
    const previous = commit.task.metadata['collaboration'];
    const state = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous as Record<string, unknown> : {};
    const previousActions = state['actions'];
    const actions = previousActions && typeof previousActions === 'object' && !Array.isArray(previousActions) ? previousActions as Record<string, unknown> : {};
    const result = { ok: true, replayed: false, taskId: commit.task.id, action: commit.action, state: commit.state, assignment: commit.assignment, committedAt: commit.committedAt };
    commit.task.metadata['collaboration'] = {
      assigneeHumanId: commit.assignment.humanId, assigneeRole: commit.assignment.role,
      state: commit.state, updatedAt: commit.committedAt,
      actions: { ...actions, [commit.idempotencyKey]: { actorTenantId: commit.actor.tenantId, actorHumanId: commit.actor.humanId, fingerprint: commit.fingerprint, result } },
    };
    hub.machine.save(commit.task.id);
    hub.activities.record({
      objectId: commit.task.businessObjectId, actor: commit.actor.humanId,
      action: `collaboration.${commit.action}`, summary: `任务 ${commit.task.id} 已${commit.state}`,
      context: { taskId: commit.task.id, state: commit.state, assignment: commit.assignment },
    });
  },
}) : undefined;
const teamsBotAdapter = store?.db && collaboration ? new TeamsBotFrameworkAdapter({
  db: store.db,
  config: teamsBotConfig,
  collaboration,
  resolveActor: (tenantId, humanId) => {
    const human = hub.org.getHuman(humanId);
    return human?.tenantId === tenantId ? { tenantId, humanId, role: human.role } : undefined;
  },
  handleNaturalLanguageApproval: async (actor, input) => {
    const approvalSession: Session = {
      username: `teams:${actor.humanId}`, tenantId: actor.tenantId, humanId: actor.humanId,
      name: actor.humanId, role: actor.role, expiresAt: Date.now() + 60_000,
    };
    if (!can(approvalSession, 'approve')) return { ok: false, code: 'TEAMS_APPROVAL_FORBIDDEN', error: '当前 Teams 绑定用户无审批权限' };
    const approval = hub.approvals.get(input.approvalId);
    const task = approval ? hub.machine.get(approval.taskId) : undefined;
    if (!approval || !task || task.tenantId !== actor.tenantId) {
      return { ok: false, code: 'TEAMS_APPROVAL_NOT_FOUND', error: '审批不存在或不属于当前租户' };
    }
    const preflight = preflightExceptionApproval(approval, task, actor.tenantId, input.decision);
    if (preflight.kind === 'replayed') {
      return { ok: true, approvalId: approval.id, taskId: task.id, decision: input.decision, taskStatus: preflight.taskStatus, replayed: true };
    }
    if (preflight.kind === 'conflict') return { ok: false, code: 'TEAMS_APPROVAL_CONFLICT', error: '该审批已提交相反结论' };
    if (preflight.kind === 'invalid') return { ok: false, code: 'TEAMS_APPROVAL_TASK_MISMATCH', error: preflight.error };
    const decided = input.decision === 'approved'
      ? await engine.approve(task.id, approval.id, actor.humanId)
      : await engine.reject(task.id, approval.id, actor.humanId, input.reason ?? '');
    return { ok: true, approvalId: approval.id, taskId: task.id, decision: input.decision, taskStatus: decided.status, replayed: false };
  },
}) : undefined;

const chat = createChatHandler({ hub, engine, tower, deployModes, connectors, context: rt.context, tools: rt.tools, ...(collaboration ? { collaboration } : {}) });

const DASHBOARD_HTML = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Readywork API</title>
<body style="font-family:-apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f7f9">
<div style="text-align:center;max-width:420px;padding:32px">
  <div style="font-size:13px;letter-spacing:.08em;color:#94a3b8;font-weight:600">Readywork</div>
  <h1 style="font-size:22px;color:#0f172a;margin:12px 0 8px">采购执行员工 · API 服务</h1>
  <p style="font-size:14px;color:#64748b;line-height:1.6">这是后端 API。请访问控制台体验 AI 员工与审批异常工作台。</p>
  <a href="http://localhost:3001" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#0f172a;color:#fff;border-radius:10px;text-decoration:none;font-size:14px">打开控制台 →</a>
</div>
</body></html>`;

// ---------------------------------------------------------------- 工具函数

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, '请求体不是有效 JSON', 'INVALID_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象', 'INVALID_BODY');
  }
  return parsed as Record<string, unknown>;
}

async function readRawBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, '请求体超过 1 MB 限制', 'BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer ')) return undefined;
  return h.slice(7);
}

function secureSessionCookie(req: IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (publicDemoMode()) return protocol === 'https';
  return process.env['NODE_ENV'] === 'production' || protocol === 'https';
}

function internalCallbackAuthorized(req: IncomingMessage): boolean {
  return req.headers['x-readywork-internal-token'] === INTERNAL_CALLBACK_TOKEN;
}

function requiredPermission(method: string, path: string): PlatformPermission {
  if (path.startsWith('/api/internal/')) return 'read';
  // The V1 publication gate is a procurement-manager decision surface, not an
  // operations mutation.  Keep the detailed runtime/readiness and incident
  // endpoints administrator-only, while allowing configure-capable managers to
  // read this already-redacted, tenant-scoped release summary.
  if (method === 'GET' && path === '/api/operations/v1-readiness') return 'configure';
  if (path.startsWith('/api/operations/')) return 'admin';
  if (path === '/api/collaboration/teams/bindings') return 'admin';
  if (/\/api\/(tasks|exceptions|editor\/runs)\/[^/]+\/(approve|reject)$/.test(path)) return 'approve';
  if (path.startsWith('/api/editor/credentials') || path.startsWith('/api/editor/connectors') || path.startsWith('/api/connectors/')) return 'admin';
  if ((method !== 'GET' && method !== 'HEAD') && (path.startsWith('/api/employees') || path.includes('/capabilities'))) return 'admin';
  if ((method !== 'GET' && method !== 'HEAD') && (path.startsWith('/api/editor/workflows') || path.startsWith('/api/editor/blueprint-upgrade') || path.startsWith('/api/editor/publish') || path.startsWith('/api/editor/versions') || path.startsWith('/api/rules'))) return 'configure';
  if (method === 'GET' || method === 'HEAD') return 'read';
  return 'operate';
}

function requestSession(req: IncomingMessage): Session | null {
  if (req.headers['authorization'] !== undefined) {
    const token = bearerToken(req);
    return token ? resolveSession(token) : null;
  }
  const cookieToken = sessionTokenFromCookie(req.headers['cookie']);
  if (cookieToken) return resolveSession(cookieToken);
  return isLoopbackRequest(req) ? localDemoSession() : null;
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const header = req.headers['origin'];
  const origin = Array.isArray(header) ? header[0] : header;
  if (!origin) return true;
  res.setHeader('vary', 'Origin');
  if (!ALLOWED_ORIGINS.has(origin)) return false;
  res.setHeader('access-control-allow-origin', origin);
  return true;
}

function boundedIntegerParam(url: URL, name: string, defaultValue: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return defaultValue;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, `${name} 必须是整数`, 'INVALID_QUERY');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, `${name} 必须在 ${min}–${max} 之间`, 'INVALID_QUERY');
  return value;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function temporalDefinition(workflow: EditorWorkflowDef, tenantId: string, employeeId: string, versionId: string, version: string): TemporalWorkflowVersion {
  return {
    tenantId,
    employeeId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    versionId,
    version,
    nodes: workflow.nodes.map((editorNode) => ({
      ...editorNode,
      config: editorNode.parameters ?? editorNode.config ?? {},
    })),
    edges: workflow.edges,
  };
}

function procurementDecision(input: Record<string, unknown>): Record<string, unknown> {
  return new ProcurementOrchestrator().decide({
    kind: String(input['kind'] ?? 'event') as 'requisition' | 'po' | 'invoice' | 'event',
    intent: input['intent'] ? String(input['intent']) as 'supplier_reject' | 'delay' | 'invoice' | 'rfq_quote' | 'other' : undefined,
    poName: input['poName'] ? String(input['poName']) : undefined,
    hasPo: Boolean(input['hasPo']),
    hasReceipt: Boolean(input['hasReceipt']),
    hasInvoice: Boolean(input['hasInvoice']),
    hasContractPrice: Boolean(input['hasContractPrice']),
    contractPriceValid: Boolean(input['contractPriceValid']),
    hasQualifiedSupplier: input['hasQualifiedSupplier'] === undefined ? undefined : Boolean(input['hasQualifiedSupplier']),
    urgent: Boolean(input['urgent']),
  }) as unknown as Record<string, unknown>;
}

function syncLegacyRuns(editorStore: EditorStore, tenantId: string, employeeId: string): void {
  const status = (task: Task): EditorRun['status'] => ({
    created: 'queued', queued: 'queued', running: 'running', waiting_external: 'waiting_external',
    waiting_approval: 'waiting_approval', waiting_human: 'waiting_external', completed: 'completed',
    failed: 'failed', cancelled: 'cancelled',
  })[task.status] as EditorRun['status'];
  for (const task of hub.machine.list().filter((item) => item.tenantId === tenantId && item.employeeId === employeeId)) {
    editorStore.recordRun({
      id: `legacy:${task.id}`,
      workflowId: task.workflowId,
      workflowName: rt.engine.get(task.workflowId)?.name ?? task.workflowId,
      workflowVersionId: `legacy:${task.workflowId}`,
      workflowVersion: 'legacy',
      mode: 'supervised',
      status: status(task),
      decision: { source: 'legacy-workflow-engine', businessObjectId: task.businessObjectId },
      sideEffects: 'approval_gate',
      message: task.error ?? nextOf(task),
      createdAt: task.createdAt,
      updatedAt: task.completedAt ?? task.failedAt ?? task.startedAt ?? task.createdAt,
      tenantId,
      employeeId,
      runtime: 'legacy',
      nodeCount: task.checkpoint.stepIndex,
      input: { businessObjectId: task.businessObjectId },
    });
  }
}

function riskOf(t: Task): string {
  const d = t.checkpoint.workspace['delay'] as { delayed?: boolean; days?: number } | undefined;
  if (t.status === 'failed') return '高';
  if (d?.delayed && (d.days ?? 0) > 7) return '高';
  if (d?.delayed) return '中';
  return '低';
}

function nextOf(t: Task): string {
  switch (t.status) {
    case 'waiting_approval':
      return '等待采购经理';
    case 'waiting_external':
      return t.checkpoint.waitingReason ?? '等待外部';
    case 'completed':
      return '—';
    case 'failed':
      return '需人工介入';
    default:
      return '执行中';
  }
}

const STATUS_ZH: Record<string, string> = {
  idle: '空闲',
  working: '执行中',
  waiting_external: '等待外部',
  waiting_approval: '审批中',
  waiting_human: '人工接管',
  failed: '失败',
  completed: '已完成',
  created: '已创建',
  queued: '排队中',
  running: '执行中',
  cancelled: '已取消',
};

function taskView(t: Task): Record<string, unknown> {
  const bo = hub.objects.get(t.businessObjectId);
  const ws = t.checkpoint.workspace;
  const agentLast = ws['agent.last'] as { reasoning?: string; output?: unknown } | undefined;
  const delay = ws['delay'] as { delayed?: boolean; days?: number; baseline?: string; newDate?: string } | undefined;
  const replyText = String(ws['replyText'] ?? '');
  const qty = bo?.attributes['qty'] ?? '';

  // AI 正在做什么（核心列）
  let aiAction: string;
  if (t.status === 'waiting_approval') aiAction = delay?.delayed ? `发现延期 ${delay.days ?? 0} 天，提交你审批` : '等待你审批';
  else if (t.status === 'waiting_external') aiAction = t.checkpoint.waitingReason ? `${t.checkpoint.waitingReason}` : '等待外部反馈';
  else if (t.status === 'running') aiAction = '正在执行…';
  else if (t.status === 'completed') aiAction = '已完成';
  else if (t.status === 'failed') aiAction = '处理失败，待人工介入';
  else aiAction = STATUS_ZH[t.status] ?? t.status;

  // AI 建议
  let recommendation: string[] = [];
  if (delay?.delayed) recommendation = ['接受新交期', '要求分批交付', '升级采购经理'];

  // 执行轨迹
  const trajectory = hub.eventLog
    .filter((e) => 'taskId' in e && (e as { taskId?: string }).taskId === t.id)
    .map((e) => ({ type: e.type, at: e.at, reason: 'reason' in e ? (e as { reason?: string }).reason : undefined }));

  // 已等待时长（小时）
  const waitingEvt = [...hub.eventLog].reverse().find((e) => e.type === 'task.waiting' && (e as { taskId?: string }).taskId === t.id);
  const waitHours = waitingEvt ? Math.max(0, Math.round((Date.now() - Date.parse(waitingEvt.at)) / 3_600_000)) : 0;

  return {
    id: t.id,
    workflowId: t.workflowId,
    employeeId: t.employeeId,
    status: t.status,
    statusZh: STATUS_ZH[t.status] ?? t.status,
    risk: riskOf(t),
    next: nextOf(t),
    attempts: t.attempts,
    error: t.error,
    createdAt: t.createdAt,
    supplier: bo?.attributes['supplierName'] ?? '—',
    item: bo?.attributes['item'] ?? '—',
    qty: qty ? `${qty}` : '',
    promise: bo?.attributes['promiseDate'] ?? '—',
    businessObjectId: t.businessObjectId,
    aiAction,
    aiJudgment: agentLast?.reasoning ?? '',
    recommendation,
    supplierReply: replyText,
    trajectory,
    waitHours,
  };
}

function tasksForTenant(tenantId: string): Task[] {
  return hub.machine.list().filter((task) => task.tenantId === tenantId);
}

function taskIdsForTenant(tenantId: string): Set<string> {
  return new Set(tasksForTenant(tenantId).map((task) => task.id));
}

function objectIdsForTenant(tenantId: string): Set<string> {
  return new Set(tasksForTenant(tenantId).map((task) => task.businessObjectId));
}

function exceptionBelongsToTenant(exc: { objectId: string; approvalId?: string }, tenantId: string): boolean {
  if (objectIdsForTenant(tenantId).has(exc.objectId)) return true;
  const approval = exc.approvalId ? hub.approvals.get(exc.approvalId) : undefined;
  return Boolean(approval && taskIdsForTenant(tenantId).has(approval.taskId));
}

function eventBelongsToTenant(event: unknown, tenantId: string): boolean {
  if (!event || typeof event !== 'object') return false;
  const item = event as { taskId?: string; employeeId?: string; objectId?: string };
  if (item.taskId) return taskIdsForTenant(tenantId).has(item.taskId);
  if (item.employeeId) return hub.org.getAI(item.employeeId)?.tenantId === tenantId;
  if (item.objectId) return objectIdsForTenant(tenantId).has(item.objectId);
  return false;
}

function kpiOf(employeeId: string): Record<string, number> {
  const d = tower.employeeDetail(employeeId);
  return {
    successRate: d.kpi.successRate,
    interventionRate: d.kpi.interventionRate,
    onTimeRate: d.kpi.onTimeRate,
    cost: d.kpi.totalCost,
  };
}

function employeeDetail(id: string, tenantId: string): Record<string, unknown> {
  const emp = hub.org.getAI(id);
  if (!emp || emp.tenantId !== tenantId) throw new HttpError(404, '员工不存在', 'EMPLOYEE_NOT_FOUND');
  const spec = hub.specs.get(emp.specId);
  if (!spec) throw new Error(`Spec 不存在: ${emp.specId}`);
  const dept = hub.org.getDepartment(emp.deptId);
  const manager = emp.managerId ? hub.org.getHuman(emp.managerId) : undefined;
  const workers = spec.workers
    .map((wid) => hub.workers.get(wid))
    .filter((w): w is NonNullable<typeof w> => Boolean(w))
    .map((w) => ({ id: w.id, name: w.name, description: w.description, capabilities: w.capabilities, taskTypes: w.taskTypes }));
  const workflows = spec.workflows.map((wid) => {
    const def = rt.engine.get(wid);
    const tasks = hub.machine.list().filter((t) => t.tenantId === tenantId && t.employeeId === emp.id && t.workflowId === wid);
    const done = tasks.filter((t) => t.status === 'completed').length;
    return {
      id: wid,
      name: def?.name ?? wid,
      description: def?.description ?? '',
      trigger: def?.trigger ?? '—',
      steps: def?.steps.length ?? 0,
      runs: tasks.length,
      success: tasks.length ? `${((done / tasks.length) * 100).toFixed(1)}%` : '—',
    };
  });
  const skills = spec.skills.map((sid) => {
    const s = rt.skills.get(sid);
    return { id: sid, name: s?.name ?? sid, description: s?.description ?? '' };
  });
  const tools = spec.tools.map((tid) => {
    const t = rt.tools.get(tid);
    return { id: tid, name: t?.name ?? tid, description: t?.description ?? '', actions: t?.actions ?? [], connected: true };
  });
  const workforceDefinition = store?.workforce.getDefinition(emp.id);
  const workforceDeployment = store?.workforce.getDeployment(emp.id);
  return {
    id: emp.id,
    name: emp.name,
    role: spec.role,
    version: spec.version,
    status: emp.status,
    statusZh: STATUS_ZH[emp.status] ?? emp.status,
    deptName: dept?.name ?? '—',
    managerName: manager?.name ?? '—',
    deployMode: deployModes.get(emp.id) ?? 'supervised',
    capabilityPackIds: workforceDefinition?.capabilityPackIds ?? capabilityPackIdsForSpec(spec),
    deployment: workforceDeployment,
    goals: spec.goals,
    budget: spec.budget,
    capabilities: spec.capabilities ?? [],
    kpi: kpiOf(emp.id),
    stats: emp.stats,
    workers,
    workflows,
    skills,
    tools,
    permissions: spec.permissions,
    policies: spec.policies.map((p) => ({ id: p.id, name: p.name, message: p.message, then: p.then })),
    approvalRules: spec.approvalRules.map((r) => ({ id: r.id, name: r.name, message: r.message })),
    contextScope: spec.contextScope,
    context: tenantId === TENANT_ID ? rt.context.snapshotFor(emp.id, spec.contextScope) : { entities: [], relationships: [] },
    tasks: hub.machine.list().filter((t) => t.tenantId === tenantId && t.employeeId === emp.id).map(taskView),
    approvals: hub.approvals.listPending().filter((a) => {
      const task = hub.machine.get(a.taskId);
      return task?.tenantId === tenantId && task.employeeId === emp.id;
    }).map((a) => ({
      id: a.id,
      taskId: a.taskId,
      title: a.title,
      message: a.message,
      payload: a.payload,
      requestedAt: a.requestedAt,
    })),
  };
}

function employeePackView(manifest: EmployeePackManifest, tenantId: string): Record<string, unknown> {
  const employeeIds = hub.org.listAI()
    .filter((employee) => employee.tenantId === tenantId && capabilityPackIdsForEmployee(employee.id).includes(manifest.id))
    .map((employee) => employee.id);
  return { manifest, installed: employeeIds.length > 0, employeeIds };
}

function employeePackDetail(id: string, tenantId: string): Record<string, unknown> {
  const manifest = employeePacks.get(id);
  if (!manifest) throw new HttpError(404, 'Employee Pack 不存在', 'EMPLOYEE_PACK_NOT_FOUND');
  return employeePackView(manifest, tenantId);
}

// ---------------------------------------------------------------- 持久化上下文恢复

/**
 * 启动时只恢复已经持久化的业务对象。空数据库必须保持真实空态；外部系统
 * 的 PO、供应商、邮件和发票只能通过各自的受控连接器或 Intake 路径进入。
 */
async function rehydrateContext(): Promise<void> {
  for (const bo of hub.objects.list()) syncObjectToContext(rt, bo);
}

async function exceptionView(exc: { id: string; type: string; severity: string; objectId: string; objectType?: string; owner?: string; aiJudgment: string; recommendedAction: string; context: Record<string, unknown>; needsApproval: boolean; approvalId?: string; status: string; createdAt: string }, tenantId: string): Promise<Record<string, unknown>> {
  const bo = hub.objects.get(exc.objectId);
  // 三单匹配/价格差异异常：结构化三栏对照（PO | 收货 | 发票），而非 JSON
  let threeWay: Record<string, unknown> | undefined;
  if (exc.type === 'three_way_mismatch' || exc.type === 'price_variance') {
    const poName = String(exc.context['po'] ?? exc.objectId ?? '');
    const runtime = odooRuntimeResolver.resolve(tenantId);
    const odooClient = runtime?.client;
    if (odooClient) {
      odooRuntimeResolver.recordUse(tenantId, 'exception.three_way_read', runtime.credential);
      try {
        const [po, receipts, bills] = await Promise.all([odooClient.readPO(poName), odooClient.listReceipts(), odooClient.listVendorBills()]);
        const receipt = receipts.find((r) => r.poName === poName);
        const bill = bills.find((b) => b.poName === poName);
        threeWay = {
          po: po ? { name: po.name, qty: po.lines[0]?.qty ?? 0, amount: po.amountTotal, promiseDate: po.promiseDate?.slice(0, 10) } : undefined,
          receipt: receipt ? { name: receipt.name, state: receipt.state, date: receipt.date } : undefined,
          invoice: bill ? { name: bill.name, amount: bill.amountTotal, date: bill.date } : undefined,
          variancePct: exc.context['variance'],
        };
      } catch {
        /* Odoo 不可达时退化为 JSON */
      }
    }
  }
  // 询价定标类：把原始报价整理成可读的供应商报价表（供应商名/报价/交期/准时率/AI评分），AI 推荐行高亮
  let quotes: Array<Record<string, unknown>> | undefined;
  let amount: number | undefined;
  if (exc.type === 'other') {
    const raw = exc.context['quotes'];
    const arr = Array.isArray(raw) ? (raw as unknown[]) : ((raw as { quotes?: unknown[] } | undefined)?.quotes ?? []);
    const rec = String(exc.context['recommendedSupplier'] ?? '');
    const finite = (value: unknown): number | null => {
      const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : null;
    };
    quotes = arr
      .map((qRaw) => {
        const q = qRaw as Record<string, unknown>;
        const sid = String(q['supplierId'] ?? '');
        const price = finite(q['unitPrice']);
        const leadTimeDays = finite(q['deliveryDays'] ?? q['leadTimeDays']);
        const onTimeRate = finite(q['onTimeRate'] ?? q['onTime']);
        const score = finite(q['score'] ?? q['totalScore']);
        const supplier = String(q['supplierName'] ?? '').trim() || sid || '供应商身份未记录';
        const currency = String(q['currency'] ?? exc.context['currency'] ?? '').trim();
        return {
          supplier,
          price,
          leadTime: leadTimeDays === null ? '—' : `${leadTimeDays} 天`,
          onTime: onTimeRate === null ? '—' : `${onTimeRate}%`,
          score,
          ...(currency ? { currency } : {}),
          recommended: sid === rec,
        };
      })
      .sort((a, b) => Number(b['recommended']) - Number(a['recommended'])
        || (b['score'] ?? Number.NEGATIVE_INFINITY) - (a['score'] ?? Number.NEGATIVE_INFINITY)
        || (a['price'] ?? Number.POSITIVE_INFINITY) - (b['price'] ?? Number.POSITIVE_INFINITY));
    // 定标金额 = 推荐供应商单价 × 数量
    const qty = Number((bo?.attributes ?? {})['qty'] ?? 0);
    const recQuote = quotes.find((q) => q['recommended']);
    if (recQuote && typeof recQuote['price'] === 'number' && qty) amount = Math.round(recQuote['price'] * qty);
  }
  return {
    id: exc.id,
    type: exc.type,
    severity: exc.severity,
    objectId: exc.objectId,
    objectType: bo?.type ?? exc.objectType,
    objectStatus: bo?.status,
    supplier: bo?.attributes['supplierName'] ?? undefined,
    item: bo?.attributes['item'] ?? undefined,
    owner: exc.owner,
    aiJudgment: exc.aiJudgment,
    recommendedAction: exc.recommendedAction,
    confidence: confidenceByType[exc.type] ?? 0.85,
    context: exc.context,
    threeWay,
    quotes,
    amount,
    needsApproval: exc.needsApproval,
    approvalId: exc.approvalId,
    status: exc.status,
    createdAt: exc.createdAt,
  };
}

/** 规则/数据核对类异常置信度高；LLM 业务判断类置信度相对低 */
const confidenceByType: Record<string, number> = {
  three_way_mismatch: 0.96,
  price_variance: 0.94,
  quantity_variance: 0.95,
  delivery_delay: 0.88,
  invoice_without_po: 0.9,
  other: 0.82,
};

function odooStateToStatus(state: string): string {
  switch (state) {
    case 'draft': return 'Draft';
    case 'sent': return 'Confirmed';
    case 'to approve': return 'Needs approval';
    case 'purchase': return 'Confirmed';
    case 'done': return 'Completed';
    case 'cancel': return 'Cancelled';
    default: return state || 'Confirmed';
  }
}

function openPersistenceWithDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  return openPersistence(path);
}

// 启动：只恢复已持久化上下文和历史等待；空数据库保持真实空态。
await rehydrateContext();
if (SERVICE_SURFACE !== 'control') {
  const rearmed = engine.rearmWaits();
  console.log(`  [boot] 已恢复 ${hub.machine.list().length} 个持久化任务，重新武装 ${rearmed} 个等待事件；未注入演示业务数据`);
}

// ---------------------------------------------------------------- 真实收件（IMAP 轮询，环境变量开关）

/**
 * IMAP 只负责协议读取。每封邮件先进入通用消息收件箱，再由采购桥接器
 * 执行身份、线程、Communication 与 DeepSeek 证据处理。持久化成功后即使
 * 领域处理暂时失败也可以标记 IMAP 已读，恢复由消息收件箱承担。
 */
async function handleInboundMail(email: InboundEmail, _extractedPoNumber: string | null): Promise<boolean> {
  const provider = inboundEmailConfig?.provider ?? 'imap';
  const mailbox = inboundEmailConfig?.mailbox ?? 'INBOX';
  const runtime = messagingRuntimes?.forTenant(TENANT_ID);
  if (!runtime || !store?.db) return false;
  const accepted=await createDurableInboundMailHandler({
    runtime,
    tenantId:TENANT_ID,
    adapterId:'email-imap',
    provider,
    mailbox,
    onPersisted:(result)=>console.log(`  [mail] 网关入站 ${result.inboundId}：received${result.replayed ? '（幂等重放）' : ''}`),
  })(email,_extractedPoNumber);
  return accepted !== false;
}

type InboundEmailConfig = { host: string; port: number; user: string; pass: string; secure: boolean; provider: string; mailbox: string };
function resolveInboundEmailConfig(): InboundEmailConfig | undefined {
  const environmentHost = process.env['IMAP_HOST'];
  const environmentUser = process.env['IMAP_USER'];
  const environmentPass = process.env['IMAP_PASS'];
  if (environmentHost && environmentUser && environmentPass) return {
    host: environmentHost,
    port: Number(process.env['IMAP_PORT'] ?? 993),
    user: environmentUser,
    pass: environmentPass,
    secure: process.env['IMAP_SECURE'] !== 'false',
    provider: `imap:${environmentHost.toLowerCase()}`,
    mailbox: process.env['IMAP_MAILBOX'] ?? 'INBOX',
  };
  const control = connectorControlPlanes.forTenant(TENANT_ID);
  const credential = control.listCredentials().find((item) => item.connectorId === 'email' && item.status === 'connected');
  const value = credential ? control.getCredential(credential.id) : undefined;
  if (!value) return undefined;
  const host = String(value['imapHost'] ?? 'imap.163.com').trim();
  const user = String(value['username'] ?? value['user'] ?? '').trim();
  const pass = String(value['authorizationCode'] ?? value['password'] ?? value['pass'] ?? '');
  if (!host || !user || !pass) return undefined;
  return {
    host,
    port: Number(value['imapPort'] ?? 993),
    user,
    pass,
    secure: value['secure'] !== false,
    provider: `imap:${host.toLowerCase()}`,
    mailbox: 'INBOX',
  };
}

function currentProcurementMessagingBridge(): ProcurementMessagingBridge | undefined {
  if (!store?.db) return undefined;
  return new ProcurementMessagingBridge({
    db: store.db,
    tenantId: TENANT_ID,
    provider: inboundEmailConfig?.provider ?? 'imap',
    mailbox: inboundEmailConfig?.mailbox ?? 'INBOX',
    ...(inboundEmailConfig?.user ? { mailboxAddress: inboundEmailConfig.user } : {}),
  });
}

const inboundEmailConfig = SERVICE_SURFACE !== 'control' && emailTransportMode === 'native'
  ? resolveInboundEmailConfig()
  : undefined;
let manualInboundMailPoll: ((actorId: string) => Promise<ProcurementInboundMailPollResult>) | undefined;
if (SERVICE_SURFACE !== 'control' && emailTransportMode === 'native') {
  recordInboundMailRuntimeState(requisitionDb, TENANT_ID, {
    configured: Boolean(inboundEmailConfig),
    connected: false,
    provider: inboundEmailConfig?.provider ?? null,
    mailbox: inboundEmailConfig?.mailbox ?? null,
  });
}
if (SERVICE_SURFACE !== 'control' && messagingRuntimes && emailTransportMode === 'native') {
    const messagingRuntime=messagingRuntimes.forTenant(TENANT_ID);
    messagingRuntime.registerEmailReceiver(createImapReceivePort(()=>inboundEmailConfig,handleInboundMail),Boolean(inboundEmailConfig));
    // Durable domain replay is installed even without a working IMAP connection.
    let recovering=false;
    const recoverInbound=async()=>{
      if (recovering) return;
      recovering=true;
      try {
        const bridge=currentProcurementMessagingBridge();
        if (bridge) await messagingRuntime.runPendingInbound(message=>bridge.handle(message));
      } catch(error) {console.warn(`  [mail] 持久化入站恢复失败: ${redactSensitive(error)}`);}
      finally {recovering=false;}
    };
    setInterval(()=>void recoverInbound(),15_000);
    void recoverInbound();
    let activePoll: Promise<ProcurementInboundMailPollResult> | null = null;
    const monitoredPoll = (trigger: 'automatic' | 'manual', actorId: string): Promise<ProcurementInboundMailPollResult> => {
      if (activePoll) return activePoll;
      const excludeUids = trigger === 'automatic' && inboundEmailConfig
        ? deferredInboundMailUids(requisitionDb, TENANT_ID, inboundEmailConfig.provider, inboundEmailConfig.mailbox)
        : undefined;
      const priorityUids = trigger === 'manual' && inboundEmailConfig
        ? rejectedInboundMailUids(requisitionDb, TENANT_ID, inboundEmailConfig.provider, inboundEmailConfig.mailbox)
        : undefined;
      activePoll = runInboundMailPoll({
        db: requisitionDb,
        tenantId: TENANT_ID,
        trigger,
        actorId,
        provider: inboundEmailConfig?.provider ?? 'imap',
        mailbox: inboundEmailConfig?.mailbox ?? 'INBOX',
        timeoutMs: 65_000,
        poll: async () => {
          const result=await messagingRuntime.gateway.poll('email-imap',{trigger,
            ...(excludeUids?{excludeUids}:{}),...(priorityUids?{priorityUids}:{})});
          if (result.status!=='received') throw new Error(result.error ?? '收件适配器不可用');
          return result.handledCount;
        },
      }).finally(() => { activePoll = null; });
      return activePoll;
    };
    manualInboundMailPoll = (actorId) => monitoredPoll('manual', actorId);
    const pollOnce = async () => {
      if (!['running','degraded'].includes(messagingRuntime.getAdapterState('email-imap').status)) return;
      try {
        const result = await runAutomaticInboundMailPollIfDue({
          db: requisitionDb,
          tenantId: TENANT_ID,
          poll: () => monitoredPoll('automatic', 'system:imap-poller'),
        });
        if (!result) return;
        if (result.handledCount) console.log(`  [mail] 本次处理 ${result.handledCount} 封供应商回信`);
      } catch (err) {
        console.warn(`  [mail] 轮询失败: ${redactSensitive(err)}`);
      }
    };
    const pollMs = inboundMailAutomaticPollIntervalMs(process.env['IMAP_POLL_MS']);
    setInterval(() => void pollOnce(), pollMs);
    void pollOnce();
    console.log(`  [mail] IMAP 网关接收生命周期已安装，每 ${pollMs / 1000}s 检查可派发状态`);
}

// 采购外部副作用由持久化 Outbox 租约派发；控制面进程不会与业务面重复抢任务。
if (SERVICE_SURFACE !== 'control' && procurementOutboxWorker) {
  let running = false;
  const pollMs = Math.min(60_000, Math.max(1_000, Number(process.env['READYWORK_OUTBOX_POLL_MS'] ?? 5_000)));
  const pollOnce = async () => {
    if (running) return;
    running = true;
    try {
      await procurementOutboxWorker.runPendingTenants();
    } catch (error) {
      console.warn(`  [outbox] 采购副作用派发失败: ${redactSensitive(error)}`);
    } finally {
      running = false;
    }
  };
  setInterval(() => void pollOnce(), pollMs);
  void pollOnce();
  console.log(`  [outbox] 持久化派发器已启动（每 ${pollMs / 1000}s）`);
}

// 文档解析使用独立持久化队列；即使 API 进程重启，超时租约也会被后续 worker 恢复。
if (SERVICE_SURFACE !== 'control' && procurementDocumentWorker) {
  let running = false;
  const pollMs = Math.min(60_000, Math.max(1_000, Number(process.env['READYWORK_DOCUMENT_POLL_MS'] ?? 3_000)));
  const pollOnce = async () => {
    if (running) return;
    running = true;
    try {
      await procurementDocumentWorker.runPendingTenants();
    } catch (error) {
      console.warn(`  [documents] 文档队列处理失败: ${redactSensitive(error)}`);
    } finally {
      running = false;
    }
  };
  setInterval(() => void pollOnce(), pollMs);
  void pollOnce();
  console.log(`  [documents] 持久化文档 worker 已启动（每 ${pollMs / 1000}s）`);
}

// SLA 自动检查只生成可审阅的内部草稿；它不跳过人工审批，也不直接发送邮件。
if (SERVICE_SURFACE !== 'control' && procurementSlaAutomationWorker) {
  let running = false;
  const configuredPollMs = Number(process.env['READYWORK_SLA_POLL_MS'] ?? 60_000);
  const pollMs = Number.isFinite(configuredPollMs) ? Math.min(60_000, Math.max(5_000, configuredPollMs)) : 60_000;
  const pollOnce = async () => {
    if (running) return;
    running = true;
    try {
      await procurementSlaAutomationWorker.runPendingTenants();
    } catch (error) {
      console.warn(`  [sla] 自动检查失败: ${redactSensitive(error)}`);
    } finally {
      running = false;
    }
  };
  setInterval(() => void pollOnce(), pollMs);
  void pollOnce();
  console.log(`  [sla] 持久化自动检查已启动（进程每 ${pollMs / 1000}s 轮询到期租户）`);
}

// 通知是采购事实的后台幂等投影。打开 Web 页面只读取结果，不隐式运行规则或写库。
if (SERVICE_SURFACE !== 'control' && procurementNotificationWorker) {
  let running = false;
  const configuredPollMs = Number(process.env['READYWORK_NOTIFICATION_POLL_MS'] ?? 60_000);
  const pollMs = Number.isFinite(configuredPollMs) ? Math.min(60_000, Math.max(5_000, configuredPollMs)) : 60_000;
  const pollOnce = () => {
    if (running) return;
    running = true;
    try {
      procurementNotificationWorker.runPendingTenants();
    } catch (error) {
      console.warn(`  [notifications] 规则投影失败: ${redactSensitive(error)}`);
    } finally {
      running = false;
    }
  };
  setInterval(pollOnce, pollMs);
  pollOnce();
  console.log(`  [notifications] 持久化规则投影已启动（每 ${pollMs / 1000}s）`);
}

// Manufacturing Context 仅在业务进程投影；coordinator 为每个发现的租户
// 创建独立 Store/Queue/projector，并在首次发现时补幂等 PO backfill。
if (manufacturingContextRuntime) {
  manufacturingContextRuntime.start();
  console.log('  [context] Manufacturing Context 多租户投影 coordinator 已启动（每 3s）');
}

// ---------------------------------------------------------------- 路由

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const requestId = randomBytes(8).toString('hex');
  res.setHeader('x-request-id', requestId);
  try {
    if (!applyCors(req, res)) {
      recordSecurityEvent(requisitionDb, { eventType: 'origin_denied', severity: 'warning', requestId, method, path, message: '请求来源不在允许列表' });
      return sendJson(res, 403, { error: '不允许的请求来源', code: 'ORIGIN_DENIED', requestId });
    }
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type,idempotency-key,x-readywork-internal-token,x-readywork-signature',
      });
      res.end();
      return;
    }
    if (publicDemoMode() && publicDemoCapabilityDenied(method, path)) {
      return sendJson(res, 403, {
        error: '公开演示环境已禁用此功能',
        code: 'PUBLIC_DEMO_CAPABILITY_DISABLED',
      });
    }
    if (!surfaceAllows(SERVICE_SURFACE, method, path)) return sendJson(res, 404, { error: `该路由不属于 ${SERVICE_SURFACE} 服务边界` });
    if (method === 'POST' && path === '/internal/demo/reset') {
      if (!publicDemoMode()) return sendJson(res, 404, { error: '未找到路由' });
      if (!internalCallbackAuthorized(req)) return sendJson(res, 401, { error: '内部回调未授权', code: 'UNAUTHORIZED' });
      try {
        return sendJson(res, 200, resetPublicDemo(requisitionDb));
      } catch (error) {
        if (error instanceof PublicDemoResetInProgressError) {
          return sendJson(res, 409, { error: '公开演示正在重置', code: error.code });
        }
        throw error;
      }
    }
    if (method === 'GET' && path === '/api/auth/config') {
      res.setHeader('cache-control', 'no-store');
      return sendJson(res, 200, {
        mode: publicDemoMode() ? 'public_demo' : demoAuthEnabled() ? 'local_demo' : 'external',
        passwordLogin: !publicDemoMode() && demoAuthEnabled(),
        demoMode: publicDemoMode(),
      });
    }

    if (method === 'POST' && path === '/api/auth/public-demo') {
      res.setHeader('cache-control', 'no-store');
      if (!publicDemoMode()) return sendJson(res, 404, { error: '未找到路由' });
      const result = createPublicDemoSession();
      res.setHeader('set-cookie', sessionCookieHeader(result.token, secureSessionCookie(req)));
      return sendJson(res, 200, {
        ok: true,
        account: { username: result.session.username, name: result.session.name, role: result.session.role, humanId: result.session.humanId },
        expiresAt: new Date(result.session.expiresAt).toISOString(),
        demoMode: true,
      });
    }

    if (method === 'POST' && path === '/api/auth/login') {
      res.setHeader('cache-control', 'no-store');
      if (!demoAuthEnabled()) {
        return sendJson(res, 503, {
          ok: false,
          error: '当前运行环境未启用本地密码登录，请接入企业身份提供方或在本机验收命令中显式开启演示认证',
          code: 'AUTH_PROVIDER_UNAVAILABLE',
        });
      }
      const body = await readBody(req);
      const r = login(String(body['username'] ?? ''), String(body['password'] ?? ''));
      if (!r) {
        recordSecurityEvent(requisitionDb, { eventType: 'authentication_failed', severity: 'warning', requestId, method, path, message: '登录验证失败' });
        return sendJson(res, 401, { ok: false, error: '用户名或密码错误', code: 'INVALID_CREDENTIALS' });
      }
      res.setHeader('set-cookie', sessionCookieHeader(r.token, secureSessionCookie(req)));
      return sendJson(res, 200, {
        ok: true,
        account: { username: r.session.username, name: r.session.name, role: r.session.role, humanId: r.session.humanId },
        expiresAt: new Date(r.session.expiresAt).toISOString(),
      });
    }

    if (method === 'POST' && path === '/api/auth/logout') {
      const body = await readBody(req);
      logout(String(body['token'] ?? bearerToken(req) ?? sessionTokenFromCookie(req.headers['cookie']) ?? ''));
      res.setHeader('cache-control', 'no-store');
      res.setHeader('set-cookie', clearSessionCookieHeader(secureSessionCookie(req)));
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && path === '/api/auth/me') {
      res.setHeader('cache-control', 'no-store');
      const s = requestSession(req);
      return s ? sendJson(res, 200, {
        ok: true,
        account: { username: s.username, name: s.name, role: s.role, humanId: s.humanId },
        expiresAt: new Date(s.expiresAt).toISOString(),
        demoMode: publicDemoMode(),
      }) : sendJson(res, 401, { ok: false, error: '未登录或会话过期', code: 'UNAUTHORIZED' });
    }

    if (method === 'GET' && path === '/api/public-demo/status') {
      res.setHeader('cache-control', 'no-store');
      if (!publicDemoMode()) return sendJson(res, 404, { error: '未找到路由' });
      const session = requestSession(req);
      if (!session) return sendJson(res, 401, { error: '未登录或会话过期', code: 'UNAUTHORIZED' });
      if (session.tenantId !== 't:public-demo') return sendJson(res, 403, { error: '公开演示租户不匹配', code: 'PUBLIC_DEMO_TENANT_MISMATCH' });
      return sendJson(res, 200, readPublicDemoStatus(requisitionDb));
    }

    if (method === 'POST' && path === '/api/public/demo-requests') {
      res.setHeader('cache-control', 'no-store');
      const idempotencyHeader = req.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
      const result = submitPublicDemoRequest(requisitionDb, await readBody(req), idempotencyKey, { source: 'navisight-product-page' });
      return sendJson(res, result.replayed ? 200 : 201, result);
    }

    if (method === 'GET' && path === '/health') return sendJson(res, 200, { ok: true, service: `readywork-${SERVICE_SURFACE}-api`, surface: SERVICE_SURFACE, version: '0.2.0', demoMode: publicDemoMode() });

    if (method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }

    const workbenchSession = requestSession(req);
    let workbenchConnectorReady: ((connectorId: string) => boolean) | undefined;
    if (workbenchSession && path.startsWith('/api/procurement/workbench/context/')) {
      try {
        const installed = await connectorControlPlanes.forTenant(workbenchSession.tenantId).list();
        workbenchConnectorReady = (connectorId) => installed.some((item) => item.id === connectorId && item.externalVerified);
      } catch {
        // Connector control-plane failure is represented as not ready in the
        // read model. Context reads remain available and fail closed.
        workbenchConnectorReady = () => false;
      }
    }
    if (await handleProcurementRouteExportRequest(req, res, path, method, {
      db: requisitionDb,
      session: workbenchSession,
      ...(attachmentObjectStorage ? { attachmentObjectStorage } : {}),
    })) return;
    if (await handleProcurementPoDocumentRequest(req, res, path, method, {
      db: requisitionDb,
      session: workbenchSession,
      ...(attachmentObjectStorage ? { attachmentObjectStorage } : {}),
    })) return;
    if (await handleProcurementWorkbenchRequest(req, res, path, method, {
      db: requisitionDb,
      session: workbenchSession,
      ...(workbenchConnectorReady ? { connectorReady: workbenchConnectorReady } : {}),
    })) return;
    if (await handleProcurementPoChatRequest(req, res, path, method, {
      db: requisitionDb,
      session: workbenchSession,
      ...(attachmentObjectStorage ? { attachmentObjectStorage } : {}),
    })) return;
    if (await handleProcurementRouteChatRequest(req, res, path, method, {
      db: requisitionDb,
      session: workbenchSession,
      ...(attachmentObjectStorage ? { attachmentObjectStorage } : {}),
    })) return;
    if (await handleProcurementConfigurationConnectionsRequest(req, res, path, method, {
      session: workbenchSession,
      db: requisitionDb,
      load: async (tenantId) => {
        const controlPlane = connectorControlPlanes.forTenant(tenantId);
        return { connectors: await controlPlane.list(), credentials: controlPlane.listCredentials() };
      },
    })) return;
    if (messagingRuntimes && await handleHermesIntegrationRequest(req, res, path, method, {
      db: requisitionDb,
      bridgeSecret: hermesBridgeSecret,
      runtimeForTenant: (tenantId) => messagingRuntimes.forTenant(tenantId),
    })) return;
    if (await handleHermesMessagingRequest(req, res, path, method, {
      db: requisitionDb,
      session: requestSession(req),
      wecomCallbackPublicUrl: process.env['READYWORK_HERMES_WECOM_CALLBACK_PUBLIC_URL'],
      ...(hermesControl ? { control: hermesControl } : {}),
      ...(messagingRuntimes ? {
        synchronizePlatforms: (tenantId, platforms) => messagingRuntimes.forTenant(tenantId).synchronizeHermesPlatforms(platforms),
      } : {}),
    })) return;
    if (messagingRuntimes && await handleMessagingRequest(req, res, path, method, {
      db: requisitionDb,
      session: requestSession(req),
      runtimeForTenant: (tenantId) => messagingRuntimes.forTenant(tenantId),
    })) return;
    if (await handleProcurementRiskDashboardRequest(req, res, path, method, { db: requisitionDb, session: requestSession(req) })) return;
    if (await handleProcurementSupplierPerformanceRequest(req, res, path, method, { db: requisitionDb, session: requestSession(req) })) return;
    if (await handleProcurementSlaRequest(req, res, path, method, { db: requisitionDb, session: requestSession(req) })) return;
    if (await handleProcurementAdvancedSlaRequest(req, res, path, method, { db: requisitionDb, session: requestSession(req) })) return;
    if (await handleProcurementCommunicationIdentityRequest(req, res, path, method, { db: requisitionDb, session: requestSession(req) })) return;
    if (await handleProcurementDeploymentProfileRequest(req, res, path, method, { db: requisitionDb, session: requestSession(req) })) return;
    if (await handleProcurementTenantPreferencesRequest(req, res, path, method, { db: requisitionDb, session: requestSession(req) })) return;
    if (await handleProcurementLeadTimeRequest(req, res, path, method, { db: requisitionDb, session: requestSession(req) })) return;
    if (await handleProcurementSlaAutomationRequest(req, res, path, method, { db: requisitionDb, session: requestSession(req) })) return;
    if (await handleProcurementInboundMailRequest(req, res, path, method, {
      db: requisitionDb,
      session: requestSession(req),
      ...(manualInboundMailPoll ? { poll: manualInboundMailPoll } : {}),
    })) return;
    if (await handleProcurementPoIntakeRequest(req, res, path, method, {
      db: requisitionDb,
      session: requestSession(req),
    })) return;
    if (await handleProcurementImportDocumentRequest(req, res, path, method, {
      db: requisitionDb,
      session: requestSession(req),
      clamAvConfigured: isClamAvConfigured(),
    })) return;
    const rfqSession = requestSession(req);
    if (await handleProcurementRfqRequest(req, res, path, method, {
      db: requisitionDb,
      session: rfqSession,
      supplierMasterProvider: rfqSession ? async () => {
        const runtime = odooRuntimeResolver.resolve(rfqSession.tenantId);
        if (!runtime) throw new HttpError(409, '当前租户的 Odoo 连接未配置、未验证或不可用', 'ODOO_NOT_CONFIGURED');
        odooRuntimeResolver.recordUse(rfqSession.tenantId, 'supplier_master.sync', runtime.credential);
        return runtime.client.listSupplierMasters();
      } : undefined,
    })) return;
    if (await handleRequisitionRequest(req, res, path, method, {
      db: requisitionDb,
      session: requestSession(req),
      ...(attachmentObjectStorage ? { attachmentObjectStorage } : {}),
    })) return;
    if (await handleOdooProcurementSyncRequest(req, res, path, method, {
      db: requisitionDb,
      session: requestSession(req),
      readerForTenant: (tenantId) => {
        const runtime = odooRuntimeResolver.resolve(tenantId);
        if (runtime) odooRuntimeResolver.recordUse(tenantId, 'procurement.snapshot.sync', runtime.credential);
        return runtime?.client;
      },
    })) return;

    const whatsappWebhookMatch = path.match(/^\/api\/connectors\/whatsapp\/webhook\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && whatsappWebhookMatch) {
      const tenantId = decodeURIComponent(whatsappWebhookMatch[1]!);
      const credentialId = decodeURIComponent(whatsappWebhookMatch[2]!);
      const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
      const result = verifyWhatsAppWebhookSubscription({
        controlPlane: connectorControlPlanes.forTenant(tenantId), credentialId,
        mode: query.get('hub.mode') ?? undefined,
        verifyToken: query.get('hub.verify_token') ?? undefined,
        challenge: query.get('hub.challenge') ?? undefined,
      });
      if (result.status !== 200) {
        recordSecurityEvent(requisitionDb, { tenantId, eventType: 'invalid_webhook_signature', severity: 'warning', requestId, method, path, message: 'WhatsApp Webhook 订阅验证失败' });
        return sendJson(res, result.status, { ok: false, error: result.error });
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(result.challenge);
      return;
    }
    if (method === 'POST' && whatsappWebhookMatch) {
      const tenantId = decodeURIComponent(whatsappWebhookMatch[1]!);
      const credentialId = decodeURIComponent(whatsappWebhookMatch[2]!);
      const rawBody = await readRawBody(req);
      const signatureHeader = req.headers['x-hub-signature-256'];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      const result = processWhatsAppWebhook({
        db: requisitionDb, tenantId, credentialId, controlPlane: connectorControlPlanes.forTenant(tenantId), rawBody,
        ...(signature ? { signature } : {}),
      });
      if (result.status === 401 || result.status === 403) {
        recordSecurityEvent(requisitionDb, { tenantId, eventType: 'invalid_webhook_signature', severity: 'warning', requestId, method, path, message: 'WhatsApp Webhook 签名验证失败' });
      }
      return sendJson(res, result.status, result.body);
    }

    const connectorWebhookMatch = path.match(/^\/api\/connectors\/webhook\/([^/]+)\/([^/]+)$/);
    if (method === 'POST' && connectorWebhookMatch) {
      const tenantId = decodeURIComponent(connectorWebhookMatch[1]!);
      const credentialId = decodeURIComponent(connectorWebhookMatch[2]!);
      const rawBody = await readRawBody(req);
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sendJson(res, 400, { ok: false, error: 'Webhook 请求体必须是 JSON 对象' });
        payload = parsed as Record<string, unknown>;
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Webhook 请求体不是有效 JSON' });
      }
      const signatureHeader = req.headers['x-readywork-signature'];
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      const result = await processSignedProcurementWebhook({
        db: requisitionDb,
        tenantId,
        credentialId,
        verifier: connectorControlPlanes.forTenant(tenantId),
        webhook: {
          rawBody: rawBody.toString('utf8'),
          payload,
          headers: req.headers as Record<string, unknown>,
          ...(signature ? { signature } : {}),
        },
      });
      if (result.status === 401 || result.status === 403) {
        recordSecurityEvent(requisitionDb, { tenantId, eventType: 'invalid_webhook_signature', severity: 'warning', requestId, method, path, message: 'Webhook 签名验证失败' });
      }
      return sendJson(res, result.status, result.body);
    }

    if (method === 'POST' && path === '/api/collaboration/teams/activities') {
      if (!teamsBotAdapter) return sendJson(res, 503, { error: 'Teams Bot 未配置', code: 'TEAMS_UNAVAILABLE' });
      const authorizationHeader = req.headers['authorization'];
      const authorization = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
      const activity = await readBody(req) as BotFrameworkActivity;
      const result = await teamsBotAdapter.handleInboundActivity(authorization, activity);
      if (result.status === 'processed') return sendJson(res, 200, result);
      if (result.status === 'unavailable') return sendJson(res, 409, result);
      if (result.status === 'rejected') {
        recordSecurityEvent(requisitionDb, { eventType: 'authentication_failed', severity: 'warning', requestId, method, path, message: `Teams 入站动作被拒绝: ${result.code}` });
        return sendJson(res, 401, result);
      }
      return sendJson(res, 503, result);
    }

    const internalRequest = path.startsWith('/api/internal/');
    if (internalRequest && !internalCallbackAuthorized(req)) {
      recordSecurityEvent(requisitionDb, { eventType: 'internal_callback_denied', severity: 'critical', requestId, method, path, message: '内部回调签名无效' });
      return sendJson(res, 401, { error: '内部回调未授权' });
    }
    const session = internalRequest ? null : requestSession(req);
    if (!internalRequest && !session) {
      recordSecurityEvent(requisitionDb, { eventType: 'authentication_failed', severity: 'warning', requestId, method, path, message: '会话缺失、无效或已过期' });
      return sendJson(res, 401, { error: '未登录或会话已过期' });
    }
    const permission = requiredPermission(method, path);
    if (!internalRequest && !can(session, permission)) {
      recordSecurityEvent(requisitionDb, { tenantId: session!.tenantId, eventType: 'authorization_denied', severity: 'warning', requestId, method, path, actorId: session!.humanId, message: `当前角色无 ${permission} 权限` });
      return sendJson(res, 403, { error: `当前角色无「${permission}」权限` });
    }

    if (await handleManufacturingContextRequest(req, res, path, method, {
      db: requisitionDb,
      session,
      internal: internalRequest,
      workerStatus: manufacturingContextRuntime?.status
        ?? ((_tenantId: string) => ({ state: 'unavailable' as const, lastHeartbeatAt: null })),
    })) return;

    const controlTenantId = session?.tenantId ?? TENANT_ID;
    const controlEmployeeId = url.searchParams.get('employee_id') ?? employees.procurement.id;
    const scopedEmployee = hub.org.getAI(controlEmployeeId);
    if (scopedEmployee && scopedEmployee.tenantId !== controlTenantId) return sendJson(res, 404, { error: '员工不存在' });
    const editorStore = editorStores.forScope({ tenantId: controlTenantId, employeeId: controlEmployeeId });
    const connectorControlPlane = connectorControlPlanes.forTenant(controlTenantId);
    const odooRuntime = session ? odooRuntimeResolver.resolve(session.tenantId) : undefined;
    const odooClient = odooRuntime?.client;
    if (odooRuntime && path.startsWith('/api/odoo/')) {
      odooRuntimeResolver.recordUse(session!.tenantId, `read:${path.slice('/api/odoo/'.length)}`, odooRuntime.credential);
    }
    if (await handleProcurementRealtimeEventsRequest(req, res, path, method, {
      db: requisitionDb,
      session,
    })) return;
    if (await handleAiReplyRequest(req, res, path, method, { db: requisitionDb, session })) return;
    if ((path.startsWith('/api/editor') || path.startsWith('/api/rules')) && !scopedEmployee) {
      return sendJson(res, 404, { error: `员工不存在: ${controlEmployeeId}` });
    }
    if (path.startsWith('/api/procurement/execution/')) {
      const installed = await connectorControlPlane.list();
      if (await handleProcurementExecutionRequest(req, res, path, method, {
        db: requisitionDb,
        session,
        connectorReady: (_channel, connectorId) => installed.some((item) => item.id === connectorId && item.externalVerified),
      })) return;
    }

    if (path.startsWith('/api/procurement/message-drafts')) {
      const installed = await connectorControlPlane.list();
      if (await handleProcurementMessageDraftRequest(req, res, path, method, {
        db: requisitionDb,
        session,
        connectorReady: (connectorId) => installed.some((item) => item.id === connectorId && item.externalVerified),
      })) return;
    }

    if (path.startsWith('/api/procurement/notifications')) {
      if (await handleProcurementNotificationRequest(req, res, path, method, {
        db: requisitionDb,
        session,
      })) return;
    }

    if (path === '/api/procurement/search') {
      if (await handleProcurementGlobalSearchRequest(req, res, path, method, {
        db: requisitionDb,
        session,
      })) return;
    }

    if (path.startsWith('/api/procurement/routes')) {
      if (await handleProcurementRouteRequest(req, res, path, method, {
        db: requisitionDb,
        session,
        clamAvConfigured: isClamAvConfigured(),
      })) return;
    }

    if (method === 'GET' && path === '/api/collaboration/my-work') {
      if (!collaboration) return sendJson(res, 503, { error: '协同控制面未配置', code: 'COLLABORATION_UNAVAILABLE' });
      const rawStatuses = url.searchParams.get('status');
      const statuses = rawStatuses === null ? undefined : rawStatuses.split(',').map((value) => value.trim()).filter(Boolean);
      const allowedStatuses = new Set(['created', 'queued', 'running', 'waiting_external', 'waiting_approval', 'waiting_human', 'completed', 'failed', 'cancelled']);
      if (statuses && (statuses.length === 0 || statuses.some((status) => !allowedStatuses.has(status)))) {
        return sendJson(res, 400, { error: 'status 必须是有效任务状态，可用逗号分隔', code: 'INVALID_TASK_STATUS' });
      }
      const includeTerminal = url.searchParams.get('includeTerminal');
      if (includeTerminal !== null && includeTerminal !== 'true' && includeTerminal !== 'false') {
        return sendJson(res, 400, { error: 'includeTerminal 只能是 true 或 false', code: 'INVALID_INCLUDE_TERMINAL' });
      }
      return sendJson(res, 200, { items: collaboration.myWork(
        { tenantId: session!.tenantId, humanId: session!.humanId, role: session!.role },
        { ...(statuses ? { statuses: statuses as Array<import('@readywork/core').Task['status']> } : {}), ...(includeTerminal === 'true' ? { includeTerminal: true } : {}) },
      ) });
    }
    if (method === 'GET' && path === '/api/collaboration/teams/bindings') {
      if (!store?.db) return sendJson(res, 503, { error: 'Teams 身份存储未配置', code: 'TEAMS_UNAVAILABLE' });
      const humanId = url.searchParams.get('humanId') ?? session!.humanId;
      const human = hub.org.getHuman(humanId);
      if (!human || human.tenantId !== session!.tenantId) return sendJson(res, 404, { error: '用户不存在', code: 'HUMAN_NOT_FOUND' });
      return sendJson(res, 200, { humanId, conversations: listTeamsConversationReferences(store.db, session!.tenantId, humanId) });
    }
    if (method === 'POST' && path === '/api/collaboration/teams/bindings') {
      if (!store?.db) return sendJson(res, 503, { error: 'Teams 身份存储未配置', code: 'TEAMS_UNAVAILABLE' });
      const body = await readBody(req);
      const humanId = String(body['readyworkHumanId'] ?? session!.humanId);
      const teamsTenantId = typeof body['teamsTenantId'] === 'string' ? body['teamsTenantId'].trim() : '';
      const aadObjectId = typeof body['aadObjectId'] === 'string' ? body['aadObjectId'].trim() : '';
      if (!teamsTenantId || !aadObjectId || teamsTenantId.length > 200 || aadObjectId.length > 200) return sendJson(res, 422, { error: 'teamsTenantId 和 aadObjectId 必填', code: 'INVALID_TEAMS_BINDING' });
      const human = hub.org.getHuman(humanId);
      if (!human || human.tenantId !== session!.tenantId) return sendJson(res, 404, { error: '用户不存在', code: 'HUMAN_NOT_FOUND' });
      return sendJson(res, 201, { binding: upsertTeamsIdentityBinding(store.db, {
        teamsTenantId, aadObjectId,
        readyworkTenantId: session!.tenantId, readyworkHumanId: humanId,
      }) });
    }
    const teamsNotificationMatch = path.match(/^\/api\/collaboration\/tasks\/([^/]+)\/teams-notification$/);
    if (method === 'POST' && teamsNotificationMatch) {
      if (!teamsBotAdapter) return sendJson(res, 503, { error: 'Teams Bot 未配置', code: 'TEAMS_UNAVAILABLE' });
      const taskId = decodeURIComponent(teamsNotificationMatch[1]!);
      const result = await teamsBotAdapter.sendProactiveTaskNotification({ tenantId: session!.tenantId, humanId: session!.humanId, role: session!.role }, taskId);
      return sendJson(res, result.status === 'sent' ? 200 : result.status === 'unavailable' ? 409 : 502, result);
    }
    const collaborationTaskMatch = path.match(/^\/api\/collaboration\/tasks\/([^/]+)$/);
    if (method === 'GET' && collaborationTaskMatch) {
      if (!collaboration) return sendJson(res, 503, { error: '协同控制面未配置', code: 'COLLABORATION_UNAVAILABLE' });
      const detail = collaboration.taskDetail({ tenantId: session!.tenantId, humanId: session!.humanId, role: session!.role }, decodeURIComponent(collaborationTaskMatch[1]!));
      return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: '任务不存在或无权查看', code: 'TASK_NOT_FOUND' });
    }
    const collaborationActionMatch = path.match(/^\/api\/collaboration\/tasks\/([^/]+)\/actions$/);
    if (method === 'POST' && collaborationActionMatch) {
      if (!collaboration) return sendJson(res, 503, { error: '协同控制面未配置', code: 'COLLABORATION_UNAVAILABLE' });
      const body = await readBody(req);
      const header = req.headers['idempotency-key'];
      const idempotencyKey = (Array.isArray(header) ? header[0] : header) ?? '';
      const action = String(body['action'] ?? '') as CollaborationAction;
      const result = await collaboration.requestAction(
        { tenantId: session!.tenantId, humanId: session!.humanId, role: session!.role },
        {
          taskId: decodeURIComponent(collaborationActionMatch[1]!), action, idempotencyKey,
          ...(typeof body['assigneeHumanId'] === 'string' ? { assigneeHumanId: body['assigneeHumanId'] } : {}),
          ...(typeof body['assigneeRole'] === 'string' ? { assigneeRole: body['assigneeRole'] } : {}),
          ...(typeof body['confirmationToken'] === 'string' ? { confirmationToken: body['confirmationToken'] } : {}),
        },
      );
      if (result.ok) return sendJson(res, 200, result);
      if (result.code === 'CONFIRMATION_REQUIRED') return sendJson(res, 202, result);
      if (result.code === 'ACTION_FORBIDDEN') return sendJson(res, 403, result);
      return sendJson(res, 409, result);
    }
    if (method === 'POST' && path === '/api/collaboration/teams/actions') {
      if (!collaboration) return sendJson(res, 503, { error: '协同控制面未配置', code: 'COLLABORATION_UNAVAILABLE' });
      const body = await readBody(req);
      const header = req.headers['idempotency-key'];
      const idempotencyKey = (Array.isArray(header) ? header[0] : header) ?? '';
      const result = await collaboration.handleTeamsAction(
        { tenantId: session!.tenantId, humanId: session!.humanId, role: session!.role },
        {
          taskId: String(body['taskId'] ?? ''), action: String(body['action'] ?? '') as CollaborationAction,
          idempotencyKey, teamsActionToken: String(body['teamsActionToken'] ?? ''),
          ...(typeof body['assigneeHumanId'] === 'string' ? { assigneeHumanId: body['assigneeHumanId'] } : {}),
          ...(typeof body['assigneeRole'] === 'string' ? { assigneeRole: body['assigneeRole'] } : {}),
          ...(typeof body['confirmationToken'] === 'string' ? { confirmationToken: body['confirmationToken'] } : {}),
        },
      );
      if (result.ok) return sendJson(res, 200, result);
      if (result.code === 'CONFIRMATION_REQUIRED') return sendJson(res, 202, result);
      if (result.code === 'ACTION_FORBIDDEN' || result.code === 'TEAMS_ACTION_INVALID') return sendJson(res, 403, result);
      return sendJson(res, 409, result);
    }

    if (method === 'GET' && (path === '/api/operations/readiness' || path === '/api/operations/v1-readiness')) {
      const [temporal, installed] = await Promise.all([temporalRuntime.health(), connectorControlPlane.list()]);
      const clamAvConfigured = isClamAvConfigured();
      const malwareScanner = observedMalwareScannerHealth(
        requisitionDb,
        session!.tenantId,
        process.env['READYWORK_CLAMD_HOST'] ? 'clamd' : 'clamscan',
        clamAvConfigured,
      );
      const readiness = productionReadiness(requisitionDb, session!.tenantId, {
        status: temporal.connected && temporal.workerObserved ? 'ready' : 'unavailable',
        workerObserved: temporal.workerObserved, pollerCount: temporal.pollerCount,
        error: temporal.error ?? temporal.workerError,
      }, installed, new Date(), {
        backend: attachmentObjectStorage ? 's3' : 'sqlite',
        configured: Boolean(attachmentObjectStorage),
        status: attachmentObjectStorage ? 'configured_unverified' : 'local',
        integrityVerification: true,
        encryption: attachmentObjectStorageConfig?.serverSideEncryption ?? 'database-file-controls',
      }, malwareScanner);
      return sendJson(res, 200, path === '/api/operations/v1-readiness'
        ? procurementV1ReadinessForOperations(requisitionDb, session!.tenantId, readiness)
        : readiness);
    }
    if (method === 'GET' && path === '/api/operations/security-events') {
      const limit = boundedIntegerParam(url, 'limit', 100, 1, 500);
      return sendJson(res, 200, { items: listSecurityEvents(requisitionDb, session!.tenantId, limit) });
    }
    if (method === 'GET' && path === '/api/operations/security-incidents') {
      const limit = boundedIntegerParam(url, 'limit', 100, 1, 500);
      return sendJson(res, 200, {
        items: listSecurityIncidents(requisitionDb, session!.tenantId, limit),
        summary: securityIncidentSummary(requisitionDb, session!.tenantId),
      });
    }
    const securityIncidentResolutionMatch = path.match(/^\/api\/operations\/security-incidents\/([a-f0-9]{40})\/resolution$/);
    if (method === 'POST' && securityIncidentResolutionMatch) {
      const body = await readBody(req);
      try {
        return sendJson(res, 200, resolveSecurityIncident(requisitionDb, {
          tenantId: session!.tenantId,
          incidentKey: securityIncidentResolutionMatch[1]!,
          status: String(body['status'] ?? '') as 'open' | 'accepted_risk' | 'resolved',
          reason: String(body['reason'] ?? ''),
          actorId: session!.humanId,
          expectedVersion: String(body['expectedVersion'] ?? ''),
        }));
      } catch (error) {
        if (error instanceof SecurityEventResolutionError) {
          const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'VERSION_CONFLICT' ? 409 : 400;
          return sendJson(res, status, { error: error.message, code: error.code });
        }
        throw error;
      }
    }
    const securityResolutionMatch = path.match(/^\/api\/operations\/security-events\/(\d+)\/resolution$/);
    if (method === 'POST' && securityResolutionMatch) {
      const body = await readBody(req);
      try {
        const result = resolveSecurityEvent(requisitionDb, {
          tenantId: session!.tenantId,
          eventSeq: Number(securityResolutionMatch[1]),
          status: String(body['status'] ?? '') as 'open' | 'accepted_risk' | 'resolved',
          reason: String(body['reason'] ?? ''),
          actorId: session!.humanId,
          expectedVersion: Number(body['expectedVersion']),
        });
        return sendJson(res, 200, result);
      } catch (error) {
        if (error instanceof SecurityEventResolutionError) {
          const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'VERSION_CONFLICT' ? 409 : 400;
          return sendJson(res, status, { error: error.message, code: error.code });
        }
        throw error;
      }
    }
    if (method === 'POST' && path === '/api/operations/outbox/dispatch') {
      if (!procurementOutboxWorker) return sendJson(res, 503, { error: 'Outbox 派发器未配置', code: 'OUTBOX_UNAVAILABLE' });
      return sendJson(res, 200, { tenantId: session!.tenantId, result: await procurementOutboxWorker.runTenant(session!.tenantId) });
    }
    if (method === 'POST' && path === '/api/operations/documents/dispatch') {
      if (!procurementDocumentWorker) return sendJson(res, 503, { error: '文档处理器未配置', code: 'DOCUMENT_WORKER_UNAVAILABLE' });
      return sendJson(res, 200, { tenantId: session!.tenantId, result: await procurementDocumentWorker.runTenant(session!.tenantId) });
    }

    if (method === 'POST' && path === '/api/chat') {
      const body = await readBody(req);
      const message = String(body['message'] ?? '');
      if (!message) return sendJson(res, 400, { error: 'message 必填' });
      const history = Array.isArray(body['history']) ? (body['history'] as { role: 'user' | 'assistant'; content: string }[]) : [];
      const actorId = session!.humanId;
      const confirm = Boolean(body['confirm']);
      const reply = await chat(message, history, actorId, session!.role, confirm);
      return sendJson(res, 200, reply);
    }

    if (method === 'GET' && path === '/api/overview') {
      const tenantEmployees = hub.org.listAI().filter((employee) => employee.tenantId === controlTenantId);
      const allTasks = tasksForTenant(controlTenantId);
      const pendingApprovals = hub.approvals.listPending().filter((approval) => taskIdsForTenant(controlTenantId).has(approval.taskId)).length;
      const active = allTasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length;
      const done = allTasks.filter((t) => t.status === 'completed').length;
      return sendJson(res, 200, {
        employees: {
          total: tenantEmployees.length,
          byStatus: countBy(tenantEmployees.map((employee) => employee.status)),
          byDepartment: countBy(tenantEmployees.map((employee) => employee.deptId)),
        },
        tasks: { total: allTasks.length, byStatus: countBy(allTasks.map((task) => task.status)), pendingApprovals },
        activeTasks: active,
        autoRate: allTasks.length ? done / allTasks.length : 0,
        totalCost: tenantEmployees.reduce((sum, employee) => sum + employee.stats.totalCost, 0),
      });
    }

    if (method === 'GET' && path === '/api/employees') {
      return sendJson(res, 200, hub.org.listAI().filter((e) => e.tenantId === controlTenantId).map((e) => {
        const d = tower.employeeDetail(e.id);
        return {
          id: e.id,
          name: e.name,
          role: d.spec.role,
          status: e.status,
          statusZh: STATUS_ZH[e.status] ?? e.status,
          capabilityPackIds: capabilityPackIdsForEmployee(e.id),
          kpi: kpiOf(e.id),
        };
      }));
    }

    if (method === 'GET' && path === '/api/employee-packs') {
      return sendJson(res, 200, { items: employeePacks.list().map((manifest) => employeePackView(manifest, controlTenantId)) });
    }

    if (method === 'GET' && path.startsWith('/api/employee-packs/')) {
      const encodedId = path.slice('/api/employee-packs/'.length);
      if (!encodedId || encodedId.includes('/')) throw new HttpError(404, 'Employee Pack 不存在', 'EMPLOYEE_PACK_NOT_FOUND');
      let id: string;
      try { id = decodeURIComponent(encodedId); } catch { throw new HttpError(400, 'Employee Pack ID 无效', 'EMPLOYEE_PACK_ID_INVALID'); }
      return sendJson(res, 200, employeePackDetail(id, controlTenantId));
    }

    if (method === 'GET' && path.startsWith('/api/employees/')) {
      return sendJson(res, 200, employeeDetail(path.slice('/api/employees/'.length), controlTenantId));
    }

    if (method === 'POST' && path.endsWith('/capabilities')) {
      const id = path.slice('/api/employees/'.length, -'/capabilities'.length);
      const emp = hub.org.getAI(id);
      if (!emp || emp.tenantId !== controlTenantId) return sendJson(res, 404, { error: '员工不存在' });
      const spec = hub.specs.get(emp.specId);
      if (!spec) return sendJson(res, 404, { error: `Spec 不存在: ${emp.specId}` });
      const body = await readBody(req);
      const add = (body['add'] as Record<string, unknown> | undefined) ?? {};
      const remove = (body['remove'] as Record<string, unknown> | undefined) ?? {};
      for (const field of ['skills', 'tools', 'workers'] as const) {
        const a = Array.isArray(add[field]) ? (add[field] as string[]) : [];
        const r = Array.isArray(remove[field]) ? (remove[field] as string[]) : [];
        spec[field] = [...new Set([...spec[field].filter((x) => !r.includes(x)), ...a])];
      }
      publishEmployeeSnapshot(emp, spec, deployModes.get(emp.id) ?? 'supervised', `${spec.version}.${Date.now()}`);
      return sendJson(res, 200, { ok: true, skills: spec.skills, tools: spec.tools, workers: spec.workers });
    }

    if (method === 'GET' && path === '/api/tasks') {
      const emp = url.searchParams.get('employee_id');
      return sendJson(res, 200, tasksForTenant(controlTenantId).filter((t) => !emp || t.employeeId === emp).map(taskView));
    }

    if (method === 'GET' && path === '/api/approvals/pending') {
      const tenantTaskIds = taskIdsForTenant(controlTenantId);
      return sendJson(res, 200, hub.approvals.listPending().filter((approval) => tenantTaskIds.has(approval.taskId)).map((a) => ({
        id: a.id,
        taskId: a.taskId,
        title: a.title,
        message: a.message,
        payload: a.payload,
        requestedAt: a.requestedAt,
      })));
    }

    // ---------------------------------------------------------------- 异常工作台

    if (method === 'GET' && path === '/api/exceptions') {
      const list = await Promise.all(hub.exceptions.listOpen().filter((exception) => exceptionBelongsToTenant(exception, controlTenantId)).map((e) => exceptionView(e, controlTenantId)));
      return sendJson(res, 200, list);
    }

    const excMatch = path.match(/^\/api\/exceptions\/([^/]+)\/(approve|reject|reassign)$/);
    if (excMatch && method === 'POST') {
      const exc = hub.exceptions.get(excMatch[1]!);
      if (!exc || !exceptionBelongsToTenant(exc, controlTenantId)) return sendJson(res, 404, { error: '异常不存在' });
      const op = excMatch[2]!;
      const body = await readBody(req);
      const by = session!.humanId;
      if (op === 'approve' || op === 'reject') {
        const approval = exc.approvalId ? hub.approvals.get(exc.approvalId) : undefined;
        if (!approval) return sendJson(res, 400, { error: '异常无关联审批，无法批准/驳回' });
        const decision = op === 'approve' ? 'approved' as const : 'rejected' as const;
        const preflight = preflightExceptionApproval(approval, hub.machine.get(approval.taskId), controlTenantId, decision);
        if (preflight.kind === 'replayed') return sendJson(res, 200, { ok: true, replayed: true, taskStatus: preflight.taskStatus, by });
        if (preflight.kind === 'conflict') return sendJson(res, 409, { error: '该审批已提交相反结论', code: 'APPROVAL_DECISION_CONFLICT' });
        if (preflight.kind === 'invalid') return sendJson(res, 409, { error: preflight.error, code: 'APPROVAL_TASK_MISMATCH' });
        const r = op === 'approve'
          ? await engine.approve(approval.taskId, approval.id, by)
          : await engine.reject(approval.taskId, approval.id, by, String(body['reason'] ?? ''));
        return sendJson(res, 200, { ok: true, taskStatus: r.status, by });
      }
      const owner = String(body['owner'] ?? by);
      const ownerEmployee = hub.org.getHuman(owner);
      if (owner !== by && ownerEmployee?.tenantId !== controlTenantId) return sendJson(res, 400, { error: '负责人不属于当前租户' });
      hub.exceptions.assign(exc.id, owner);
      return sendJson(res, 200, { ok: true, owner: hub.exceptions.get(exc.id)?.owner, by });
    }

    if (method === 'GET' && path === '/api/events') {
      const emp = url.searchParams.get('employee_id');
      let events = tower.recentEvents(120).filter((event) => eventBelongsToTenant(event, controlTenantId));
      if (emp) events = events.filter((e) => 'employeeId' in e && (e as { employeeId?: string }).employeeId === emp);
      return sendJson(res, 200, events);
    }

    if (method === 'GET' && path === '/api/org') {
      const departments = hub.org.listDepartments().filter((department) => department.tenantId === controlTenantId);
      const humans = hub.org.listHumans().filter((human) => human.tenantId === controlTenantId);
      const tenantEmployees = hub.org.listAI().filter((employee) => employee.tenantId === controlTenantId);
      return sendJson(res, 200, {
        tenants: hub.org.getTenant(controlTenantId) ? [hub.org.getTenant(controlTenantId)] : [],
        departments: departments.map((d) => ({
          ...d,
          aiCount: tenantEmployees.filter((e) => e.deptId === d.id).length,
          humanCount: humans.filter((h) => h.deptId === d.id).length,
        })),
        humans,
        employees: tenantEmployees.map((e) => ({
          id: e.id,
          name: e.name,
          specId: e.specId,
          role: e.role,
          status: e.status,
          statusZh: STATUS_ZH[e.status] ?? e.status,
          deptId: e.deptId,
          managerId: e.managerId,
        })),
      });
    }

    if (method === 'GET' && path === '/api/context') {
      if (controlTenantId !== TENANT_ID) throw new HttpError(409, '当前租户尚未启用隔离上下文存储', 'TENANT_CONTEXT_UNAVAILABLE');
      const snap = rt.context.snapshotFor('*', []);
      return sendJson(res, 200, { entities: snap.entities, relationships: snap.relationships });
    }

    if (method === 'GET' && path === '/api/tools') {
      const connectorReadiness = new Map((await connectorControlPlane.list()).map((connector) => [connector.id, connector]));
      return sendJson(res, 200, {
        tools: rt.tools.list().map((tool) => {
          const connector = connectorReadiness.get(tool.id);
          const implementationMode = tool.id === 'pdf' || tool.id === 'excel' ? 'reference' as const : connector?.implementationMode ?? 'reference' as const;
          return {
            id: tool.id,
            name: tool.name,
            actions: tool.actions,
            implementationMode,
            connected: implementationMode === 'real' && connector?.externalVerified === true,
          };
        }),
        connectors: connectors.list().map((c) => ({ id: c.id, name: c.name, category: c.category, description: c.description, status: c.status() })),
      });
    }

    if (method === 'GET' && path === '/api/connectors') {
      return sendJson(res, 200, connectors.list().map((c) => ({ id: c.id, name: c.name, category: c.category, description: c.description, status: c.status() })));
    }

    if (method === 'GET' && path === '/api/odoo/orders') {
      if (!odooClient) return sendJson(res, 200, { ok: false, orders: [], note: '当前租户的 Odoo 连接未配置、未验证或不可用' });
      try {
        const pos = await odooClient.listPOs();
        const orders = pos.map((p) => ({
          id: p.name,
          supplier: p.supplierName,
          date: (p.dateOrder || '').slice(0, 10),
          delivery: (p.promiseDate || '').slice(0, 10),
          value: `¥${Math.round(Number(p.amountTotal) || 0).toLocaleString('zh-CN')}`,
          status: odooStateToStatus(p.state),
          progress: p.lines[0]?.product ?? `${p.lines.length} 种物料`,
          item: p.lines[0]?.product ?? '',
          owner: '王经理',
          state: p.state,
        }));
        return sendJson(res, 200, { ok: true, orders });
      } catch (err) {
        return sendJson(res, 200, { ok: false, orders: [], note: publicIntegrationError(err) });
      }
    }

    if (method === 'GET' && path === '/api/odoo/sourcing') {
      if (!odooClient) return sendJson(res, 200, { ok: false, sourcing: [] });
      try {
        const pos = await odooClient.listPOs();
        const sourcing = pos.filter((p) => p.state === 'draft').map((p) => ({
          id: p.name,
          title: p.lines[0]?.product ?? `${p.lines.length} 种物料`,
          stage: 'Draft',
          bids: 0,
          value: `¥${Math.round(Number(p.amountTotal) || 0).toLocaleString('zh-CN')}`,
          due: (p.promiseDate || '').slice(0, 10),
          tags: [p.supplierName, '待发询价'],
        }));
        return sendJson(res, 200, { ok: true, sourcing });
      } catch (err) {
        return sendJson(res, 200, { ok: false, sourcing: [], note: publicIntegrationError(err) });
      }
    }

    if (method === 'GET' && path === '/api/odoo/exceptions') {
      if (!odooClient) return sendJson(res, 200, { ok: false, exceptions: [] });
      try {
        const pos = await odooClient.listPOs();
        const now = Date.now();
        const exceptions = pos
          .filter((p) => p.state === 'purchase' && p.promiseDate && Date.parse(p.promiseDate) < now)
          .map((p) => ({
            title: `交期已逾期 ${p.name}`,
            type: 'Delivery exception',
            supplier: p.supplierName,
            priority: 'High',
            status: 'Open',
            due: (p.promiseDate || '').slice(0, 10),
            note: `订单 ${p.name}（${p.lines[0]?.product ?? ''}）承诺交期 ${(p.promiseDate || '').slice(0, 10)} 已逾期，建议立即催交。`,
          }));
        return sendJson(res, 200, { ok: true, exceptions });
      } catch (err) {
        return sendJson(res, 200, { ok: false, exceptions: [], note: publicIntegrationError(err) });
      }
    }

    if (method === 'GET' && path === '/api/odoo/invoices') {
      if (!odooClient) return sendJson(res, 200, { ok: false, invoices: [] });
      try {
        const [bills, receipts, pos] = await Promise.all([odooClient.listVendorBills(), odooClient.listReceipts(), odooClient.listPOs()]);
        const invoices = bills.map((b) => {
          const po = pos.find((p) => p.name === b.poName);
          const receipt = receipts.find((r) => r.poName === b.poName);
          // 三单匹配比对发票金额 vs 采购单未税金额（Odoo 订单 amount_total 含税）
          const poAmt = po ? (po.amountUntaxed || po.amountTotal) : 0;
          const variance = po ? Math.round((b.amountTotal - poAmt) * 100) / 100 : 0;
          const match = po ? (Math.abs(variance) < 0.01 ? 'Matched' : 'Variance') : 'Review';
          return {
            id: b.name,
            supplier: b.supplierName,
            po: b.poName,
            amount: `¥${Math.round(b.amountTotal).toLocaleString('zh-CN')}`,
            match,
            reason: match === 'Matched' ? '三单匹配完成' : match === 'Variance' ? `金额差异 ${variance >= 0 ? '+' : ''}${variance}` : '未关联采购单',
            date: b.date,
            received: Boolean(receipt),
          };
        });
        return sendJson(res, 200, { ok: true, invoices });
      } catch (err) {
        return sendJson(res, 200, { ok: false, invoices: [], note: publicIntegrationError(err) });
      }
    }

    if (method === 'GET' && path === '/api/editor/catalog') {
      return sendJson(res, 200, editorStore.catalog());
    }

    if (method === 'GET' && path === '/api/editor/runtime') {
      const [temporal, runtimeConnectors] = await Promise.all([temporalRuntime.health(), connectorControlPlane.list()]);
      return sendJson(res, 200, {
        agentRuntime: agentRuntimeStatus(temporal.workerObserved),
        graphEngine: { name: 'Readywork Graph Runtime', nodeFactory: true, variablePool: true, graphValidation: true, humanInputProtocol: true },
        temporal,
        connectors: {
          installed: runtimeConnectors.filter((connector) => connector.status === 'installed').length,
          available: runtimeConnectors.length,
          healthy: runtimeConnectors.filter((connector) => connector.healthy).length,
        },
        credentials: connectorControlPlane.credentialStatus(),
      });
    }

    if (method === 'GET' && path === '/api/editor/connectors') {
      return sendJson(res, 200, await connectorControlPlane.list());
    }

    if (method === 'GET' && path === '/api/editor/connectors/events') {
      const limit = boundedIntegerParam(url, 'limit', 100, 1, 500);
      return sendJson(res, 200, connectorControlPlane.listEvents(limit));
    }

    const editorConnectorLifecycleMatch = path.match(/^\/api\/editor\/connectors\/([^/]+)\/(install|enable|disable|upgrade|uninstall)$/);
    if (editorConnectorLifecycleMatch && method === 'POST') {
      const connectorId = decodeURIComponent(editorConnectorLifecycleMatch[1]!);
      const operation = editorConnectorLifecycleMatch[2]!;
      const body = await readBody(req);
      const config = isRecord(body['config']) ? body['config'] : {};
      if (operation === 'install') return sendJson(res, 201, await connectorControlPlane.install(connectorId, config));
      if (operation === 'enable') return sendJson(res, 200, await connectorControlPlane.enable(connectorId));
      if (operation === 'disable') return sendJson(res, 200, await connectorControlPlane.disable(connectorId));
      if (operation === 'upgrade') return sendJson(res, 200, await connectorControlPlane.upgrade(connectorId, config));
      await connectorControlPlane.uninstall(connectorId);
      return sendJson(res, 200, { ok: true, connectorId, status: 'available' });
    }

    if (method === 'GET' && path === '/api/editor/credentials') {
      return sendJson(res, 200, { status: connectorControlPlane.credentialStatus(), items: connectorControlPlane.listCredentials() });
    }

    if (method === 'POST' && path === '/api/editor/credentials') {
      const body = await readBody(req);
      if (!body['id'] || !body['connectorId'] || !body['credentialType'] || !body['name'] || !isRecord(body['value'])) return sendJson(res, 400, { error: 'id、connectorId、credentialType、name、value 必填，value 必须是对象' });
      connectorControlPlane.putCredential({ id: String(body['id']), connectorId: String(body['connectorId']), credentialType: String(body['credentialType']), name: String(body['name']), value: body['value'] as Record<string, import('@readywork/graph-runtime').JsonValue> });
      return sendJson(res, 201, { ok: true, items: connectorControlPlane.listCredentials() });
    }

    const editorCredentialMatch = path.match(/^\/api\/editor\/credentials\/([^/]+)(?:\/(test))?$/);
    if (editorCredentialMatch && method === 'POST' && editorCredentialMatch[2] === 'test') {
      const result = await connectorControlPlane.testCredential(decodeURIComponent(editorCredentialMatch[1]!));
      return sendJson(res, result.ok ? 200 : 422, result);
    }
    if (editorCredentialMatch && method === 'DELETE' && !editorCredentialMatch[2]) {
      const credentialId = decodeURIComponent(editorCredentialMatch[1]!);
      const credential = connectorControlPlane.listCredentials().find((item) => item.id === credentialId);
      return connectorControlPlane.deleteCredential(credentialId)
        ? sendJson(res, 200, { ok: true, connectorId: credential!.connectorId, credentialId, disconnected: true })
        : sendJson(res, 404, { error: '凭据不存在' });
    }

    if (method === 'GET' && path === '/api/editor/workflows') {
      return sendJson(res, 200, editorStore.listWorkflows());
    }

    if (method === 'GET' && path === '/api/editor/blueprint-upgrade') {
      return sendJson(res, 200, editorStore.previewBlueprintUpgrade());
    }

    if (method === 'POST' && path === '/api/editor/blueprint-upgrade') {
      const body = await readBody(req);
      if (body['confirm'] !== true) throw new HttpError(400, '导入蓝图需要显式确认 confirm: true', 'BLUEPRINT_CONFIRMATION_REQUIRED');
      if (!isRecord(body['expectedRevisions'])) throw new HttpError(400, 'expectedRevisions 必须是工作流 revision 对象', 'BLUEPRINT_REVISIONS_REQUIRED');
      const idempotencyKey = String(body['idempotencyKey'] ?? '').trim();
      if (!idempotencyKey || idempotencyKey.length > 200) throw new HttpError(400, 'idempotencyKey 必须为 1–200 字符', 'INVALID_IDEMPOTENCY_KEY');
      const expectedRevisions = Object.fromEntries(Object.entries(body['expectedRevisions']).map(([workflowId, revision]) => {
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new EditorRevisionRequiredError();
        return [workflowId, revision];
      }));
      return sendJson(res, 200, editorStore.importBlueprint({ expectedRevisions, idempotencyKey, actorId: session!.humanId }));
    }

    // 显式迁移契约：先 GET 预览影响，再 POST { confirm: true, expectedRevision } 写入。
    // 不接受隐式/后台升级，避免覆盖用户正在编辑的旧草稿。
    const invoiceMatchUpgradeMatch = path.match(/^\/api\/editor\/workflows\/([^/]+)\/invoice-match-upgrade$/);
    if (invoiceMatchUpgradeMatch && method === 'GET') {
      const workflowId = decodeURIComponent(invoiceMatchUpgradeMatch[1]!);
      try {
        return sendJson(res, 200, editorStore.previewInvoiceMatchUpgrade(workflowId));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('工作流不存在:')) return sendJson(res, 404, { error: '工作流不存在' });
        throw error;
      }
    }
    if (invoiceMatchUpgradeMatch && method === 'POST') {
      const workflowId = decodeURIComponent(invoiceMatchUpgradeMatch[1]!);
      const body = await readBody(req);
      if (body['confirm'] !== true) throw new HttpError(400, '升级需要显式确认 confirm: true', 'UPGRADE_CONFIRMATION_REQUIRED');
      const expectedRevision = body['expectedRevision'];
      if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new EditorRevisionRequiredError();
      try {
        const result = editorStore.upgradeInvoiceMatch(workflowId, expectedRevision);
        if (result.status === 'not_applicable') return sendJson(res, 409, { error: result.preview.reason, code: 'INVOICE_MATCH_UPGRADE_NOT_APPLICABLE', preview: result.preview });
        return sendJson(res, 200, result);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('工作流不存在:')) return sendJson(res, 404, { error: '工作流不存在' });
        throw error;
      }
    }

    const editorWorkflowMatch = path.match(/^\/api\/editor\/workflows\/([^/]+)$/);
    if (editorWorkflowMatch && method === 'GET') {
      const workflow = editorStore.getWorkflow(decodeURIComponent(editorWorkflowMatch[1]!));
      return workflow ? sendJson(res, 200, workflow) : sendJson(res, 404, { error: '工作流不存在' });
    }
    if (editorWorkflowMatch && method === 'PUT') {
      const body = await readBody(req);
      const workflow = editorStore.saveWorkflow(decodeURIComponent(editorWorkflowMatch[1]!), body);
      return sendJson(res, 200, workflow);
    }

    const editorRunMatch = path.match(/^\/api\/editor\/workflows\/([^/]+)\/run$/);
    if (editorRunMatch && method === 'POST') {
      const workflowId = decodeURIComponent(editorRunMatch[1]!);
      const workflow = editorStore.getWorkflow(workflowId);
      if (!workflow) return sendJson(res, 404, { error: '工作流不存在' });
      const body = await readBody(req);
      const mode = String(body['mode'] ?? 'simulate') as EditorRunMode;
      if (!['simulate', 'shadow', 'supervised', 'autonomous'].includes(mode)) return sendJson(res, 400, { error: '运行模式无效' });
      if (mode === 'autonomous' && workflow.draftRevision !== workflow.publishedRevision) {
        return sendJson(res, 409, { error: '当前工作流有未发布更改，请先发布再进入自动运行' });
      }
      if (body['input'] !== undefined && !isRecord(body['input'])) throw new HttpError(400, 'input 必须是 JSON 对象', 'INVALID_INPUT');
      const input = (isRecord(body['input']) ? body['input'] : {
        kind: 'event', hasPo: false, hasInvoice: false, hasReceipt: false, hasContractPrice: false,
      }) as Record<string, unknown>;
      const employeeId = controlEmployeeId;
      if (body['employeeId'] && String(body['employeeId']) !== employeeId) return sendJson(res, 409, { error: '请求路径与运行员工不一致' });
      if (mode === 'shadow') deployModes.set(employeeId, 'shadow');
      if (mode === 'supervised') deployModes.set(employeeId, 'supervised');
      if (mode === 'autonomous') deployModes.set(employeeId, 'autonomous');
      const published = editorStore.currentVersionSnapshot(workflowId);
      const source = mode === 'autonomous' && published ? published.workflow : workflow;
      const versionId = mode === 'autonomous' && published ? published.version.id : `draft:${workflow.id}:r${workflow.draftRevision}`;
      const version = mode === 'autonomous' && published ? published.version.version : `draft-r${workflow.draftRevision}`;
      const runId = uid('editor-run');
      const now = nowIso();
      const idempotencyKey = String(body['idempotencyKey'] ?? '').trim();
      if (!idempotencyKey || idempotencyKey.length > 200) throw new HttpError(400, 'idempotencyKey 必填且不能超过 200 个字符', 'IDEMPOTENCY_KEY_REQUIRED');
      const sideEffects = mode === 'simulate' || mode === 'shadow' ? 'blocked' as const : mode === 'supervised' ? 'approval_gate' as const : 'enabled' as const;
      const claimed = editorStore.claimRun({
        id: runId,
        workflowId,
        workflowName: source.name,
        workflowVersionId: versionId,
        workflowVersion: version,
        mode,
        status: 'queued',
        decision: employeeId === employees.procurement.id ? procurementDecision(input) : { entry: 'employee-task', workflows: [workflowId], skipped: [], reason: '按当前员工能力包执行' },
        sideEffects,
        message: '已提交 Temporal 持久化运行队列',
        createdAt: now,
        updatedAt: now,
        tenantId: controlTenantId,
        employeeId,
        runtime: 'temporal',
        input,
        idempotencyKey,
      });
      if (!claimed.created) {
        const existing = claimed.run;
        if (existing.workflowId !== workflowId || existing.employeeId !== employeeId || existing.mode !== mode || JSON.stringify(existing.input ?? {}) !== JSON.stringify(input)) {
          throw new HttpError(409, '该幂等键已用于不同的运行请求', 'IDEMPOTENCY_KEY_REUSED');
        }
        return sendJson(res, 200, { ...existing, replayed: true, nodeRuns: editorStore.listNodeRuns(existing.id) });
      }
      try {
        const temporal = await temporalRuntime.start({
          runId,
          mode,
          definition: temporalDefinition(source, controlTenantId, employeeId, versionId, version),
          input,
          callbackBaseUrl: `http://127.0.0.1:${PORT}`,
          callbackToken: INTERNAL_CALLBACK_TOKEN,
        });
        const run = editorStore.updateRun(runId, {
          status: 'running',
          temporalWorkflowId: temporal.workflowId,
          temporalRunId: temporal.temporalRunId,
          message: 'Temporal 已接管执行，节点状态将持续写回',
        });
        return sendJson(res, 201, { ...run, nodeRuns: [] });
      } catch (error) {
        editorStore.updateRun(runId, { status: 'failed', message: publicIntegrationError(error) });
        throw new HttpError(503, '工作流运行服务暂时不可用', 'TEMPORAL_UNAVAILABLE');
      }
    }

    if (method === 'GET' && path === '/api/editor/runs') {
      const limit = boundedIntegerParam(url, 'limit', 50, 1, 200);
      syncLegacyRuns(editorStore, controlTenantId, controlEmployeeId);
      const reconciled = await reconcileTemporalRuns(editorStore, editorStore.listRuns(limit), temporalRuntime);
      return sendJson(res, 200, reconciled.map((item) => ({ ...item.run, reconciliation: item.reconciliation })));
    }

    const editorRunDetailMatch = path.match(/^\/api\/editor\/runs\/([^/]+)$/);
    if (editorRunDetailMatch && method === 'GET') {
      const runId = decodeURIComponent(editorRunDetailMatch[1]!);
      syncLegacyRuns(editorStore, controlTenantId, controlEmployeeId);
      let run = editorStore.getRun(runId);
      if (!run) return sendJson(res, 404, { error: '运行不存在' });
      const reconciled = await reconcileTemporalRun(editorStore, run, temporalRuntime);
      run = reconciled.run;
      return sendJson(res, 200, { ...run, temporalState: reconciled.temporalState, reconciliation: reconciled.reconciliation, nodeRuns: editorStore.listNodeRuns(runId), businessActivities: editorStore.listBusinessActivities(runId) });
    }

    const editorRunActionMatch = path.match(/^\/api\/editor\/runs\/([^/]+)\/(approve|reject|event|cancel)$/);
    if (editorRunActionMatch && method === 'POST') {
      const runId = decodeURIComponent(editorRunActionMatch[1]!);
      const action = editorRunActionMatch[2]!;
      const run = editorStore.getRun(runId);
      if (!run?.temporalWorkflowId) return sendJson(res, 404, { error: 'Temporal 运行不存在' });
      const body = await readBody(req);
      if (action === 'approve' || action === 'reject') {
        const requestedDecision = action === 'approve' ? 'approved' as const : 'rejected' as const;
        const requestedNodeId = typeof body['nodeId'] === 'string' ? body['nodeId'].trim() : '';
        const existing = requestedNodeId
          ? existingEditorApprovalDecision(requisitionDb, controlTenantId, runId, requestedNodeId, requestedDecision, session!.humanId)
          : undefined;
        if (existing) {
          if (existing?.kind === 'replayed') return sendJson(res, 200, { ok: true, replayed: true, decision: existing.decision, run: editorStore.getRun(runId) });
          if (existing?.kind === 'conflict') return sendJson(res, 409, { error: '该审批已提交相反结论', code: 'APPROVAL_DECISION_CONFLICT' });
          if (existing?.kind === 'processing') return sendJson(res, 409, { error: '该审批结论正在提交', code: 'APPROVAL_DECISION_PROCESSING' });
        }
        let temporalState;
        try {
          temporalState = await temporalRuntime.queryState(run.temporalWorkflowId);
        } catch (error) {
          throw new HttpError(503, publicIntegrationError(error), 'TEMPORAL_APPROVAL_STATE_UNAVAILABLE');
        }
        // 只允许客户端指定动作、当前节点和备注；绑定键及审批身份来自可信状态与会话。
        const prepared = prepareEditorApprovalSignal(temporalState, session!, body, requestedDecision);
        if (!prepared.ok) {
          // pending 租约过期时，先以 Temporal 的不可伪造审计确认信号是否已经被接收。
          // 审计没有该结论就绝不把中断请求伪装成成功。
          if (existing?.kind === 'recoverable' && temporalStateRecordedApproval(temporalState, existing.payload)) {
            markEditorApprovalDecisionSent(requisitionDb, controlTenantId, runId, existing.payload);
            return sendJson(res, 200, { ok: true, replayed: true, decision: existing.decision, run: editorStore.getRun(runId) });
          }
          return sendJson(res, prepared.status, { error: prepared.error, code: prepared.code });
        }
        const claim = claimEditorApprovalDecision(requisitionDb, controlTenantId, runId, prepared.payload);
        if (claim.kind === 'replayed') return sendJson(res, 200, { ok: true, replayed: true, decision: claim.payload.decision, run: editorStore.getRun(runId) });
        if (claim.kind === 'conflict') return sendJson(res, 409, { error: '该审批已提交相反结论', code: 'APPROVAL_DECISION_CONFLICT' });
        if (claim.kind === 'processing') return sendJson(res, 409, { error: '该审批结论正在提交', code: 'APPROVAL_DECISION_PROCESSING' });
        try {
          await temporalRuntime.approve(run.temporalWorkflowId, prepared.payload);
          markEditorApprovalDecisionSent(requisitionDb, controlTenantId, runId, prepared.payload);
        } catch (error) {
          markEditorApprovalDecisionFailed(requisitionDb, controlTenantId, runId, prepared.payload);
          throw new HttpError(503, publicIntegrationError(error), 'TEMPORAL_APPROVAL_SIGNAL_UNAVAILABLE');
        }
      } else if (action === 'event') {
        const eventType = String(body['eventType'] ?? 'external_event');
        await temporalRuntime.signalEvent(run.temporalWorkflowId, { eventType, nodeId: body['nodeId'] ? String(body['nodeId']) : undefined, payload: body['payload'] && typeof body['payload'] === 'object' ? body['payload'] as Record<string, unknown> : {} });
      } else {
        await temporalRuntime.cancel(run.temporalWorkflowId);
        editorStore.updateRun(runId, { status: 'cancelled', message: '运行已取消' });
      }
      return sendJson(res, 200, { ok: true, run: editorStore.getRun(runId) });
    }

    const internalNodeStartMatch = path.match(/^\/api\/internal\/runs\/([^/]+)\/nodes\/start$/);
    if (internalNodeStartMatch && method === 'POST') {
      if (!internalCallbackAuthorized(req)) return sendJson(res, 401, { error: '内部回调未授权' });
      const runId = decodeURIComponent(internalNodeStartMatch[1]!);
      const runEditorStore = editorStores.forRun(runId, { tenantId: controlTenantId, employeeId: controlEmployeeId });
      const body = await readBody(req);
      const run = runEditorStore.getRun(runId);
      if (!run) return sendJson(res, 404, { error: '运行不存在' });
      const nodeRun = runEditorStore.startNodeRun({
        runId,
        nodeId: String(body['nodeId'] ?? ''),
        nodeLabel: String(body['nodeLabel'] ?? body['nodeId'] ?? ''),
        nodeKind: String(body['nodeKind'] ?? 'action') as EditorNodeRun['nodeKind'],
        attempt: Math.max(1, Number(body['attempt'] ?? 1)),
        input: body['input'] && typeof body['input'] === 'object' ? body['input'] as Record<string, unknown> : {},
        startedAt: String(body['startedAt'] ?? nowIso()),
      });
      runEditorStore.updateRun(runId, { status: 'running', message: `正在执行：${nodeRun.nodeLabel}` });
      return sendJson(res, 201, nodeRun);
    }

    const internalNodeFinishMatch = path.match(/^\/api\/internal\/runs\/([^/]+)\/nodes\/finish$/);
    if (internalNodeFinishMatch && method === 'POST') {
      if (!internalCallbackAuthorized(req)) return sendJson(res, 401, { error: '内部回调未授权' });
      const runId = decodeURIComponent(internalNodeFinishMatch[1]!);
      const runEditorStore = editorStores.forRun(runId, { tenantId: controlTenantId, employeeId: controlEmployeeId });
      const body = await readBody(req);
      const status = String(body['status'] ?? 'completed') as EditorNodeRun['status'];
      const nodeRun = runEditorStore.finishNodeRun(runId, String(body['nodeId'] ?? ''), {
        status,
        output: body['output'] && typeof body['output'] === 'object' ? body['output'] as Record<string, unknown> : {},
        error: body['error'] ? String(body['error']) : undefined,
        sideEffectStatus: String(body['sideEffectStatus'] ?? 'none') as EditorNodeRun['sideEffectStatus'],
        message: body['message'] ? String(body['message']) : undefined,
        finishedAt: String(body['finishedAt'] ?? nowIso()),
      });
      return sendJson(res, 200, nodeRun);
    }

    const internalRunStatusMatch = path.match(/^\/api\/internal\/runs\/([^/]+)\/status$/);
    if (internalRunStatusMatch && method === 'POST') {
      if (!internalCallbackAuthorized(req)) return sendJson(res, 401, { error: '内部回调未授权' });
      const runId = decodeURIComponent(internalRunStatusMatch[1]!);
      const runEditorStore = editorStores.forRun(runId, { tenantId: controlTenantId, employeeId: controlEmployeeId });
      const body = await readBody(req);
      const nodeRuns = runEditorStore.listNodeRuns(runId);
      const run = runEditorStore.updateRun(runId, {
        status: String(body['status'] ?? 'running') as EditorRun['status'],
        message: String(body['message'] ?? ''),
        output: body['output'] && typeof body['output'] === 'object' ? body['output'] as Record<string, unknown> : undefined,
        nodeCount: nodeRuns.length,
        updatedAt: String(body['updatedAt'] ?? nowIso()),
      });
      return sendJson(res, 200, run);
    }

    if (method === 'POST' && path === '/api/internal/actions/execute') {
      if (!internalCallbackAuthorized(req)) return sendJson(res, 401, { error: '内部回调未授权' });
      const body = await readBody(req);
      const runId = String(body['runId'] ?? '');
      const actionTenantId = String(body['tenantId'] ?? TENANT_ID);
      const actionEmployeeId = String(body['employeeId'] ?? employees.procurement.id);
      const runStore = editorStores.forRun(runId, { tenantId: actionTenantId, employeeId: actionEmployeeId });
      const actionRun = runStore.getRun(runId);
      if (!actionRun || actionRun.tenantId !== actionTenantId || actionRun.employeeId !== actionEmployeeId) return sendJson(res, 409, { error: '运行、租户与员工上下文不一致' });
      const result = await actionGateway.execute({
        runId,
        tenantId: actionTenantId,
        employeeId: actionEmployeeId,
        node: body['node'] as import('./editor.js').EditorNodeDef,
        input: body['input'] && typeof body['input'] === 'object' ? body['input'] as Record<string, unknown> : {},
        mode: String(body['mode'] ?? 'simulate') as EditorRunMode,
      });
      return sendJson(res, result.ok ? 200 : 422, result);
    }

    if (method === 'GET' && path === '/api/editor/versions') {
      return sendJson(res, 200, editorStore.listVersions());
    }

    if (method === 'POST' && path === '/api/editor/publish') {
      const body = await readBody(req);
      return sendJson(res, 201, editorStore.publish(body['note'] ? String(body['note']) : undefined));
    }

    const editorRollbackMatch = path.match(/^\/api\/editor\/versions\/([^/]+)\/rollback$/);
    if (editorRollbackMatch && method === 'POST') {
      return sendJson(res, 201, editorStore.rollback(decodeURIComponent(editorRollbackMatch[1]!)));
    }

    if (method === 'GET' && path === '/api/rules') {
      const currentRules = editorStore.currentRuleSet();
      const ruleThresholds = currentRules?.thresholds ?? APPROVAL_THRESHOLDS;
      const zh: Record<string, { name: string; unit: string }> = {
        deliveryDelayDays: { name: '交期延期', unit: '天' },
        poPriceVariancePct: { name: 'PO 价格变化', unit: '%' },
        threeWayVariancePct: { name: '三单匹配差异', unit: '%' },
      };
      const thresholds = Object.entries(ruleThresholds).map(([kind, t]) => {
        const meta = zh[kind] ?? { name: kind, unit: '' };
        const middle = kind === 'threeWayVariancePct' ? '财务审批' : '采购员审批';
        const high = kind === 'threeWayVariancePct' ? '采购+财务审批' : '采购经理审批';
        return { kind, name: meta.name, unit: meta.unit, auto: t.auto, buyer: t.buyer, note: `≤${t.auto}${meta.unit} 自动通过；${t.auto}-${t.buyer}${meta.unit} ${middle}；>${t.buyer}${meta.unit} ${high}`, level: approvalLevel(kind as keyof typeof APPROVAL_THRESHOLDS, t.auto + 0.1) };
      });
      const exceptionTypes = Object.entries(EXCEPTION_TYPES).map(([key, id]) => ({ key, id }));
      return sendJson(res, 200, { version: currentRules?.version, createdAt: currentRules?.createdAt, thresholds, exceptionTypes });
    }

    const ruleMatch = path.match(/^\/api\/rules\/([^/]+)$/);
    if (ruleMatch && method === 'PUT') {
      const kind = decodeURIComponent(ruleMatch[1]!);
      if (!APPROVAL_THRESHOLDS[kind]) return sendJson(res, 404, { error: '审批阈值不存在' });
      const body = await readBody(req);
      const auto = Number(body['auto']);
      const buyer = Number(body['buyer']);
      if (!Number.isFinite(auto) || !Number.isFinite(buyer) || auto < 0 || buyer <= auto) return sendJson(res, 400, { error: '阈值必须满足 0 ≤ auto < buyer' });
      const thresholds = { ...(editorStore.currentRuleSet()?.thresholds ?? APPROVAL_THRESHOLDS), [kind]: { auto, buyer } };
      const ruleSet = editorStore.publishRuleSet(thresholds);
      for (const [ruleKind, threshold] of Object.entries(ruleSet.thresholds)) APPROVAL_THRESHOLDS[ruleKind] = { ...threshold };
      syncThresholdToEditor(editorStore, kind, auto, buyer);
      return sendJson(res, 200, { kind, auto, buyer, level: approvalLevel(kind, auto + 0.1), ruleSet });
    }

    if (method === 'POST' && path === '/api/orchestrate') {
      const body = await readBody(req);
      const decision = new ProcurementOrchestrator().decide({
        kind: String(body['kind'] ?? 'event') as 'requisition' | 'po' | 'invoice' | 'event',
        intent: body['intent'] ? String(body['intent']) as 'supplier_reject' | 'delay' | 'invoice' | 'rfq_quote' | 'other' : undefined,
        poName: body['poName'] ? String(body['poName']) : undefined,
        hasPo: Boolean(body['hasPo']),
        hasReceipt: Boolean(body['hasReceipt']),
        hasInvoice: Boolean(body['hasInvoice']),
        hasContractPrice: Boolean(body['hasContractPrice']),
        contractPriceValid: Boolean(body['contractPriceValid']),
        hasQualifiedSupplier: body['hasQualifiedSupplier'] === undefined ? undefined : Boolean(body['hasQualifiedSupplier']),
        urgent: Boolean(body['urgent']),
      });
      return sendJson(res, 200, decision);
    }

    if (method === 'GET' && path === '/api/odoo/board') {
      if (!odooClient) return sendJson(res, 200, { ok: false, suppliers: [], metrics: null, note: '当前租户的 Odoo 连接未配置、未验证或不可用' });
      try {
        const board = await odooClient.board();
        const colors = ['red', 'blue', 'gold', 'purp'];
        const suppliers = board.suppliers.map((s, i) => ({
          name: s.name,
          open: s.openOrders,
          risk: s.overdue ? 'High' : 'Low',
          spend: `¥${(s.spend / 10000).toFixed(1)}万`,
          country: s.country || '中国',
          code: s.name.slice(0, 2),
          c: colors[i % colors.length],
        }));
        return sendJson(res, 200, { ok: true, suppliers, metrics: board.metrics });
      } catch (err) {
        return sendJson(res, 200, { ok: false, suppliers: [], metrics: null, note: publicIntegrationError(err) });
      }
    }

    const connectorMatch = path.match(/^\/api\/connectors\/([^/]+)\/(connect|disconnect)$/);
    if (connectorMatch && method === 'POST') {
      const c = connectors.get(connectorMatch[1]!);
      if (!c) return sendJson(res, 404, { error: `连接器不存在: ${connectorMatch[1]}` });
      const result = connectorMatch[2] === 'connect' ? await c.connect() : await c.disconnect();
      return sendJson(res, 200, { id: c.id, status: c.status(), ...result });
    }

    if (method === 'POST' && path === '/api/connectors/netease-mail/send') {
      const body = await readBody(req);
      const mail = connectors.get('netease-mail') as NetEaseMailConnector | undefined;
      if (!mail) return sendJson(res, 400, { error: '网易邮箱连接器不可用' });
      const r = await mail.send({ to: String(body['to'] ?? ''), subject: String(body['subject'] ?? ''), body: String(body['body'] ?? '') });
      return sendJson(res, 200, r);
    }

    if (method === 'GET' && path === '/api/catalog') {
      return sendJson(res, 200, {
        workers: hub.workers.list().map((w) => ({ id: w.id, name: w.name, description: w.description })),
        skills: rt.skills.list().map((s) => ({ id: s.id, name: s.name })),
        tools: rt.tools.list().map((t) => ({ id: t.id, name: t.name, actions: t.actions })),
        contextTypes: ['po', 'supplier', 'email', 'requisition', 'rfq', 'contract', 'invoice', 'payment', 'conversation', 'document'],
        departments: hub.org.listDepartments().filter((department) => department.tenantId === controlTenantId).map((d) => ({ id: d.id, name: d.name })),
      });
    }

    if (method === 'POST' && path === '/api/employees/wizard') {
      const b = await readBody(req);
      const name = String(b['name'] ?? '').trim();
      if (!name) return sendJson(res, 400, { error: '员工名称必填' });
      const role = String(b['role'] ?? '');
      const departmentId = String(b['departmentId'] ?? 'dept:procurement');
      if (hub.org.getDepartment(departmentId)?.tenantId !== controlTenantId) return sendJson(res, 400, { error: '部门不属于当前租户' });
      const goalTitle = String(b['goalTitle'] ?? '');
      const goalDescription = String(b['goalDescription'] ?? '');
      const kpiName = String(b['kpiName'] ?? '');
      const kpiTarget = Number(b['kpiTarget'] ?? 0);
      const kpiUnit = String(b['kpiUnit'] ?? '%');
      const contextScope = Array.isArray(b['contextScope']) ? (b['contextScope'] as string[]) : [];
      const workers = Array.isArray(b['workers']) ? (b['workers'] as string[]) : [];
      const skills = Array.isArray(b['skills']) ? (b['skills'] as string[]) : [];
      const tools = Array.isArray(b['tools']) ? (b['tools'] as string[]) : [];
      const allowActions = Array.isArray(b['allowActions']) ? (b['allowActions'] as string[]) : [];
      const denyActions = Array.isArray(b['denyActions']) ? (b['denyActions'] as string[]) : [];
      const approvalRules = Array.isArray(b['approvalRules']) ? (b['approvalRules'] as { name: string; message: string }[]) : [];
      const budgetCap = Number(b['budgetCap'] ?? 0);
      const deployMode = (String(b['deployMode'] ?? 'supervised') || 'supervised') as 'shadow' | 'supervised' | 'autonomous';

      const parseAction = (a: string) => {
        const i = a.indexOf('.');
        return i >= 0 ? { resource: a.slice(0, i), action: a.slice(i + 1) } : { resource: '*', action: a };
      };
      const specId = `spec:custom-${++specSeq}`;
      const spec: EmployeeSpec = {
        id: specId,
        name,
        departmentId,
        version: '1.0.0',
        role: role || name,
        goals: goalTitle ? [{ id: 'g1', title: goalTitle, description: goalDescription, kpis: kpiName ? [{ id: 'k1', name: kpiName, unit: kpiUnit, target: kpiTarget }] : [] }] : [],
        workers,
        workflows: [],
        skills,
        tools,
        permissions: [
          ...allowActions.map((a) => ({ effect: 'allow' as const, ...parseAction(a) })),
          ...denyActions.map((a) => ({ effect: 'deny' as const, ...parseAction(a) })),
        ],
        policies: [],
        approvalRules: approvalRules.map((r, i) => ({ id: `custom-rule-${i + 1}`, name: r.name, message: r.message, when: () => false, approver: 'manager' })),
        budget: budgetCap > 0 ? { monthlyCap: budgetCap, currency: 'CNY' } : undefined,
        contextScope,
        evalCriteria: [{ id: 'e1', name: '任务成功率', formula: 'success_rate' }],
        humanEscalation: { contactIds: ['h:procurement-manager'] },
      };
      hub.specs.register(spec);
      const id = `ai:custom-${specSeq}`;
      const emp = hub.org.registerAI({
        id, tenantId: controlTenantId, deptId: departmentId, specId, name, role: spec.role,
        status: 'idle', managerId: session!.humanId, stats: emptyStats(), createdAt: nowIso(),
      });
      deployModes.set(id, deployMode);
      store?.org.save({ kind: 'ai', id: emp.id, json: JSON.stringify(emp) });
      publishEmployeeSnapshot(emp, spec, deployMode);
      return sendJson(res, 201, { id, name, specId, role: spec.role, status: 'idle', deployMode });
    }

    if (method === 'POST' && path === '/api/employees') {
      const body = await readBody(req);
      const specId = String(body['specId'] ?? 'spec:po-ops');
      const spec = hub.specs.get(specId);
      if (!spec) return sendJson(res, 400, { error: `Spec 不存在: ${specId}` });
      if (hub.org.getDepartment(spec.departmentId)?.tenantId !== controlTenantId) return sendJson(res, 400, { error: 'Spec 所属部门不属于当前租户' });
      employeeSeq += 1;
      const id = `ai:${specId.replace('spec:', '')}-${employeeSeq}`;
      const name = String(body['name'] ?? spec.name);
      const emp = hub.org.registerAI({
        id,
        tenantId: controlTenantId,
        deptId: spec.departmentId,
        specId,
        name,
        role: spec.role,
        status: 'idle',
        managerId: session!.humanId,
        stats: emptyStats(),
        createdAt: nowIso(),
      });
      deployModes.set(id, 'shadow');
      store?.org.save({ kind: 'ai', id: emp.id, json: JSON.stringify(emp) });
      publishEmployeeSnapshot(emp, spec, 'shadow');
      return sendJson(res, 201, { id, name, specId, role: spec.role, status: 'idle', deployMode: 'shadow' });
    }

    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)\/(approve|reject|resume)$/);
    if (taskMatch && method === 'POST') {
      const taskId = taskMatch[1]!;
      const op = taskMatch[2]!;
      const body = await readBody(req);
      const task = hub.machine.get(taskId);
      if (!task || task.tenantId !== controlTenantId) return sendJson(res, 404, { error: '任务不存在' });
      const by = session!.humanId;
      if (op === 'approve') {
        const approvalId = String(body['approvalId'] ?? '');
        return sendJson(res, 200, await engine.approve(taskId, approvalId, by));
      }
      if (op === 'reject') {
        const approvalId = String(body['approvalId'] ?? '');
        return sendJson(res, 200, await engine.reject(taskId, approvalId, by, String(body['reason'] ?? '')));
      }
      return sendJson(res, 200, await engine.resume(taskId));
    }

    const modeMatch = path.match(/^\/api\/employees\/([^/]+)\/deploy-mode$/);
    if (modeMatch && method === 'POST') {
      const body = await readBody(req);
      const mode = String(body['mode'] ?? 'supervised') as 'shadow' | 'supervised' | 'autonomous';
      if (!['shadow', 'supervised', 'autonomous'].includes(mode)) return sendJson(res, 400, { error: '运行模式无效' });
      const employee = hub.org.getAI(modeMatch[1]!);
      if (!employee || employee.tenantId !== controlTenantId) return sendJson(res, 404, { error: '员工不存在' });
      deployModes.set(modeMatch[1]!, mode);
      const spec = hub.specs.get(employee.specId);
      if (spec) publishEmployeeSnapshot(employee, spec, mode, store?.workforce.getVersion(store.workforce.getDeployment(employee.id)?.versionId ?? '')?.version ?? spec.version);
      return sendJson(res, 200, { ok: true, employeeId: modeMatch[1], mode });
    }

    sendJson(res, 404, { error: `未找到路由: ${method} ${path}` });
  } catch (err) {
    if (err instanceof EditorRevisionRequiredError) {
      sendJson(res, 400, { error: '保存时必须提供有效的 expectedRevision', code: 'REVISION_REQUIRED', requestId });
      return;
    }
    if (err instanceof EditorRevisionConflictError) {
      sendJson(res, 409, { error: '工作流已被其他会话修改，请刷新后重试', code: 'REVISION_CONFLICT', currentRevision: err.currentRevision, requestId });
      return;
    }
    if (err instanceof EditorIdempotencyConflictError) {
      sendJson(res, 409, { error: err.message, code: 'IDEMPOTENCY_KEY_REUSED', requestId });
      return;
    }
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.publicMessage, code: err.code, requestId });
      return;
    }
    console.error(`[request:${requestId}] ${method} ${path}: ${redactSensitive(err)}`);
    sendJson(res, 500, { error: '服务器内部错误', code: 'INTERNAL_ERROR', requestId });
  }
});

server.requestTimeout = 30_000;
// Keep proxy-facing sockets alive longer than the console's pooled upstream
// connection. A five-second idle timeout lets Next.js reuse a socket just as
// the API closes it, which surfaces as a transient 500 / ECONNRESET in the Web
// console even though an immediate retry succeeds.
server.headersTimeout = 70_000;
server.keepAliveTimeout = 65_000;

server.listen(PORT, HOST, () => {
  console.log(`\n  AI Workforce OS · ${SERVICE_SURFACE} API → http://${HOST}:${PORT}`);
  console.log('  GET  /api/overview                    控制塔总览');
  console.log('  GET  /api/employees                   AI 员工列表');
  console.log('  GET  /api/employees/:id               员工详情（workers/workflows/skills/tools/policies）');
  console.log('  GET  /api/employee-packs              已安装 Employee Pack 清单与员工绑定');
  console.log('  GET  /api/tasks?employee_id=          任务列表');
  console.log('  GET  /api/approvals/pending           待审批');
  console.log('  GET  /api/editor/workflows            Editor 工作流蓝图');
  console.log('  GET  /api/editor/blueprint-upgrade     Employee Pack 蓝图差异预览');
  console.log('  POST /api/editor/blueprint-upgrade     备份并显式导入 Pack 蓝图');
  console.log('  PUT  /api/editor/workflows/:id        保存节点与连线');
  console.log('  POST /api/editor/workflows/:id/run    模拟/影子/审批/自动运行');
  console.log('  POST /api/editor/publish              发布工作流版本');
  console.log('  POST /api/tasks/:id/approve|reject|resume');
  console.log('  POST /api/employees/:id/deploy-mode   {mode}');
  console.log('');
});
