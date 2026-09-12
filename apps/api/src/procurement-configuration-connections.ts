import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { can, type Session } from './auth.js';
import type { ConnectorCredentialView, ConnectorInstallationView } from './connector-control-plane.js';
import { normalizeDraftRecipient } from './procurement-message-drafts.js';

const CONFIGURATION_CONNECTIONS_PATH = '/api/procurement/configuration/connections';
const MANAGED_CONNECTOR_IDS = new Set(['email', 'whatsapp', 'deepseek', 'erp']);
const CONNECTION_ORDER = ['email', 'whatsapp', 'wechat', 'deepseek', 'erp'] as const;
type ConfigurationConnectionId = typeof CONNECTION_ORDER[number];
type AutoSendGateId = 'permission' | 'published_profile' | 'communication_identity' | 'allowlists' | 'supplier_target' | 'connector' | 'kill_switch';

const CONNECTION_TYPES: Record<ConfigurationConnectionId, string> = {
  email: 'SMTP / IMAP',
  whatsapp: 'Meta WhatsApp Cloud API',
  wechat: 'Not available',
  deepseek: 'DeepSeek 官方 API',
  erp: 'Odoo ERP',
};

export interface ProcurementConfigurationConnectionsSource {
  connectors: ConnectorInstallationView[];
  credentials: ConnectorCredentialView[];
}

export interface ProcurementConfigurationConnectionSummary {
  id: ConfigurationConnectionId;
  connectionType: string;
  status: ConnectorInstallationView['status'] | 'unavailable';
  runtimeHealthy: boolean;
  credentialReady: boolean;
  externalVerified: boolean;
  credentialCount: number;
  lastTestedAt: string | null;
  healthMessage: string;
}

interface PublishedAutoSendProfile {
  id: string;
  version: number;
  schema_version: number;
  auto_send_json: string;
}

interface AutoSendPolicy {
  enabled: boolean;
  stages: string[];
  channels: Array<'email' | 'whatsapp'>;
  risks: string[];
}

interface AutoSendGate {
  id: AutoSendGateId;
  label: string;
  status: 'ready' | 'blocked';
  detail: string;
}

export async function handleProcurementConfigurationConnectionsRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: {
    session: Session | null;
    db: DatabaseSync;
    load: (tenantId: string) => Promise<ProcurementConfigurationConnectionsSource>;
  },
): Promise<boolean> {
  if (path !== CONFIGURATION_CONNECTIONS_PATH) return false;
  if (!context.session) return json(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
  if (!can(context.session, 'read')) return json(res, 403, { error: '无读取连接状态权限', code: 'FORBIDDEN' });
  if (method !== 'GET') return json(res, 405, { error: '连接状态只支持读取', code: 'METHOD_NOT_ALLOWED' });

  try {
    const source = await context.load(context.session.tenantId);
    const connections = summarizeConnections(source);
    return json(res, 200, {
      connections,
      permissions: { manage: can(context.session, 'admin') },
      autoSend: autoSendReadiness(context.db, context.session, connections),
    });
  } catch {
    return json(res, 503, {
      error: '连接状态暂时不可用，请稍后重试',
      code: 'CONFIGURATION_CONNECTIONS_UNAVAILABLE',
    });
  }
}

function summarizeConnections(source: ProcurementConfigurationConnectionsSource): ProcurementConfigurationConnectionSummary[] {
  const connectors = source.connectors.filter((item) => MANAGED_CONNECTOR_IDS.has(item.id));
  const credentials = source.credentials.filter((item) => MANAGED_CONNECTOR_IDS.has(item.connectorId));
  return CONNECTION_ORDER.map((id) => {
    if (id === 'wechat') return {
      id,
      connectionType: CONNECTION_TYPES[id],
      status: 'unavailable' as const,
      runtimeHealthy: false,
      credentialReady: false,
      externalVerified: false,
      credentialCount: 0,
      lastTestedAt: null,
      healthMessage: 'Not available / Not configured',
    };
    const connector = connectors.find((item) => item.id === id);
    const connectorCredentials = credentials
      .filter((item) => item.connectorId === id)
      .sort((left, right) => String(right.lastTestedAt ?? '').localeCompare(String(left.lastTestedAt ?? '')));
    const latest = connectorCredentials[0];
    return {
      id,
      connectionType: CONNECTION_TYPES[id],
      status: connector?.status ?? 'available',
      runtimeHealthy: connector?.runtimeHealthy === true,
      credentialReady: connector?.credentialReady === true,
      externalVerified: connector?.externalVerified === true,
      credentialCount: Number(connector?.credentialCount ?? connectorCredentials.length),
      lastTestedAt: latest?.lastTestedAt ?? null,
      healthMessage: latest?.lastError ?? connector?.healthMessage ?? (connector ? '尚未完成真实外部验证' : '连接器尚未安装'),
    };
  });
}

function autoSendReadiness(
  db: DatabaseSync,
  session: Session,
  connections: readonly ProcurementConfigurationConnectionSummary[],
) {
  const profile = db.prepare(`SELECT id,version,schema_version,auto_send_json
    FROM procurement_advanced_sla_profiles WHERE tenant_id=? AND status='published'
    ORDER BY published_at DESC,id LIMIT 1`).get(session.tenantId) as PublishedAutoSendProfile | undefined;
  const policy = parseAutoSendPolicy(profile?.auto_send_json);
  const permissionReady = can(session, 'configure') && can(session, 'approve');
  const profileReady = Boolean(profile && profile.schema_version === 2);
  const identityReady = Boolean(db.prepare(`SELECT 1 FROM procurement_communication_identities
    WHERE tenant_id=? AND status='active'`).get(session.tenantId));
  const allowlistsReady = profileReady && policy.enabled && policy.stages.length > 0 && policy.channels.length > 0 && policy.risks.length > 0;
  const targetReady = allowlistsReady && allCurrentSupplierTargetsVerified(db, session.tenantId, policy.channels);
  const connectorReady = allowlistsReady && policy.channels.every((channel) => {
    const connection = connections.find((item) => item.id === channel);
    return connection?.status === 'installed'
      && connection.runtimeHealthy
      && connection.credentialReady
      && connection.externalVerified
      && connection.credentialCount > 0;
  });
  const runtime = profile ? db.prepare(`SELECT profile_version,paused FROM procurement_advanced_sla_runtime_controls
    WHERE tenant_id=? AND profile_id=?`).get(session.tenantId, profile.id) as { profile_version: number; paused: number } | undefined : undefined;
  const killSwitchReady = Boolean(profileReady && runtime && runtime.profile_version === profile!.version && runtime.paused === 0);

  const gates: AutoSendGate[] = [
    gate('permission', '配置与审批权限', permissionReady, permissionReady ? '当前身份同时具备配置和审批权限。' : '启用自动发送需要同时具备配置与审批权限。'),
    gate('published_profile', '已发布的高级 SLA v2 配置', profileReady, profileReady ? `已发布 ${profile!.id} v${profile!.version}。` : '尚无已发布的高级 SLA 架构 v2 配置。'),
    gate('communication_identity', '具名采购身份', identityReady, identityReady ? '供应商可见的具名采购身份已启用。' : '尚未启用供应商可见的具名采购身份。'),
    gate('allowlists', '阶段、通道与风险允许列表', allowlistsReady, allowlistsReady ? `${policy.stages.length} 个阶段 · ${policy.channels.length} 个通道 · ${policy.risks.length} 个风险等级` : '策略必须启用，并明确阶段、通道与风险允许列表。'),
    gate('supplier_target', '已验证的供应商目标', targetReady, targetReady ? '当前活动采购单的供应商目标均可按允许通道规范化。' : '当前没有完整可验证的供应商目标，或至少一个活动采购单缺少允许通道收件人。'),
    gate('connector', '健康且已验证的连接器', connectorReady, connectorReady ? '允许通道的运行时、凭据和外部验证均就绪。' : allowlistsReady ? '至少一个允许通道缺少健康运行时、可用凭据或外部验证。' : '完成通道允许列表后才能核验连接器。'),
    gate('kill_switch', '终止开关正在运行', killSwitchReady, killSwitchReady ? '已发布配置的运行控制处于运行状态。' : '运行控制缺失、版本不匹配或终止开关已暂停。'),
  ];
  const blockers = gates.filter((item) => item.status === 'blocked');
  return {
    enabled: policy.enabled,
    ready: blockers.length === 0,
    profileId: profile?.id ?? null,
    profileVersion: profile?.version ?? null,
    stageAllowlist: policy.stages,
    channelAllowlist: policy.channels,
    riskAllowlist: policy.risks,
    gates,
    blockers,
  };
}

function gate(id: AutoSendGateId, label: string, ready: boolean, detail: string): AutoSendGate {
  return { id, label, status: ready ? 'ready' : 'blocked', detail };
}

function parseAutoSendPolicy(value: string | undefined): AutoSendPolicy {
  if (!value) return { enabled: false, stages: [], channels: [], risks: [] };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return {
      enabled: parsed['enabled'] === true,
      stages: stringArray(parsed['stages']),
      channels: stringArray(parsed['channels']).filter((item): item is 'email' | 'whatsapp' => item === 'email' || item === 'whatsapp'),
      risks: stringArray(parsed['risks']),
    };
  } catch {
    return { enabled: false, stages: [], channels: [], risks: [] };
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function allCurrentSupplierTargetsVerified(db: DatabaseSync, tenantId: string, channels: readonly ('email' | 'whatsapp')[]): boolean {
  const purchaseOrders = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' AND status NOT IN ('cancelled','completed','rejected')
    ORDER BY id`).all(tenantId) as Array<{ json: string }>;
  if (purchaseOrders.length === 0) return false;
  const suppliers = new Map<string, Record<string, unknown>>();
  for (const row of db.prepare(`SELECT id,json FROM procurement_documents WHERE tenant_id=? AND kind='supplier'`).all(tenantId) as Array<{ id: string; json: string }>) {
    const value = parseRecord(row.json);
    if (value) suppliers.set(row.id, value);
  }
  return purchaseOrders.every((row) => {
    const po = parseRecord(row.json);
    const supplierId = typeof po?.['supplierId'] === 'string' ? po['supplierId'] : '';
    const supplier = suppliers.get(supplierId);
    const contacts = Array.isArray(supplier?.['contacts']) ? supplier['contacts'].filter(isRecord) : [];
    return channels.some((channel) => contacts.some((contact) => {
      const candidate = channel === 'email' ? contact['email'] : contact['phone'];
      if (typeof candidate !== 'string') return false;
      try { normalizeDraftRecipient(channel, candidate); return true; } catch { return false; }
    }));
  });
}

function parseRecord(value: string): Record<string, unknown> | null {
  try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : null; }
  catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
  return true;
}
