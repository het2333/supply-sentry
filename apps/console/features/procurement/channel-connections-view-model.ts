export type ConfigurationConnectionId = "email" | "whatsapp" | "wechat" | "deepseek" | "erp";
export type ChannelConnectionCategory = "communication" | "ai" | "business";
export type ChannelConnectionState = "connected" | "test_required" | "setup_required" | "attention" | "disabled" | "unavailable";

export interface ChannelConnectionSummary {
  id: ConfigurationConnectionId;
  connectionType: string;
  status: "available" | "installing" | "installed" | "disabled" | "failed" | "unavailable";
  runtimeHealthy: boolean;
  credentialReady: boolean;
  externalVerified: boolean;
  credentialCount: number;
  lastTestedAt: string | null;
  healthMessage: string;
}

export type ConfigurationAutoSendGateId = "permission" | "published_profile" | "communication_identity" | "allowlists" | "supplier_target" | "connector" | "kill_switch";

export interface ConfigurationAutoSendGate {
  id: ConfigurationAutoSendGateId;
  label: string;
  status: "ready" | "blocked";
  detail: string;
}

export interface ConfigurationAutoSendSummary {
  enabled: boolean;
  ready: boolean;
  profileId: string | null;
  profileVersion: number | null;
  stageAllowlist: string[];
  channelAllowlist: Array<"email" | "whatsapp">;
  riskAllowlist: string[];
  gates: ConfigurationAutoSendGate[];
  blockers: ConfigurationAutoSendGate[];
}

export function createLatestConfigurationConnectionsLoader<T>(
  request: () => Promise<T>,
  handlers: {
    onStart: () => void;
    onSuccess: (payload: T) => void;
    onError: (error: unknown) => void;
  },
): () => Promise<void> {
  let latestGeneration = 0;
  return async () => {
    const generation = ++latestGeneration;
    handlers.onStart();
    try {
      const payload = await request();
      if (generation !== latestGeneration) return;
      handlers.onSuccess(payload);
    } catch (error) {
      if (generation !== latestGeneration) return;
      handlers.onError(error);
    }
  };
}

export interface ChannelConnectionView extends ChannelConnectionSummary {
  connectorId: ConfigurationConnectionId;
  category: ChannelConnectionCategory;
  title: string;
  description: string;
  state: ChannelConnectionState;
  stateLabel: string;
  detail: string;
  actionLabel: string;
}

const CHANNELS: Array<Pick<ChannelConnectionView, "connectorId" | "category" | "title" | "description">> = [
  { connectorId: "email", category: "communication", title: "邮件智能体", description: "连接已验证的公司邮箱，用于接收、分类和发送邮件。" },
  { connectorId: "whatsapp", category: "communication", title: "WhatsApp 智能体", description: "使用 Meta WhatsApp Cloud API 发送已批准模板并读取投递回执。" },
  { connectorId: "deepseek", category: "ai", title: "DeepSeek AI", description: "使用 DeepSeek 官方 API 解析供应商回信，并将结构化结果交给业务规则核验。" },
  { connectorId: "erp", category: "business", title: "ERP / Odoo", description: "Odoo ERP 采购单、收货 / GRN 与受控回写" },
];

const stateLabels: Record<ChannelConnectionState, string> = {
  connected: "已验证",
  test_required: "待测试",
  setup_required: "未配置",
  attention: "需要修复",
  disabled: "已停用",
  unavailable: "不可用",
};

function unavailableSummary(id: ConfigurationConnectionId): ChannelConnectionSummary {
  return {
    id,
    connectionType: id === "wechat" ? "暂不可用" : "服务端未返回",
    status: "unavailable",
    runtimeHealthy: false,
    credentialReady: false,
    externalVerified: false,
    credentialCount: 0,
    lastTestedAt: null,
    healthMessage: id === "wechat" ? "暂不可用 / 未配置" : "服务端未返回该连接摘要",
  };
}

function connectionState(connection: ChannelConnectionSummary): ChannelConnectionState {
  if (connection.status === "unavailable") return "unavailable";
  if (connection.status === "disabled") return "disabled";
  if (connection.status === "failed" || (connection.status === "installed" && !connection.runtimeHealthy)) return "attention";
  if (connection.status !== "installed") return "setup_required";
  if (connection.credentialCount > 0 && !connection.credentialReady) return "attention";
  if (connection.externalVerified && connection.credentialReady && connection.credentialCount > 0) return "connected";
  if (connection.credentialCount > 0) return "test_required";
  return "setup_required";
}

function actionLabel(state: ChannelConnectionState): string {
  if (state === "connected") return "查看连接";
  if (state === "test_required") return "去测试连接";
  if (state === "attention") return "修复连接";
  if (state === "disabled") return "去启用";
  if (state === "unavailable") return "暂不可配置";
  return "配置并验证";
}

export function buildChannelConnectionViews(connections: readonly ChannelConnectionSummary[]): ChannelConnectionView[] {
  return CHANNELS.map((channel) => {
    const connection = connections.find((item) => item.id === channel.connectorId) ?? unavailableSummary(channel.connectorId);
    const state = connectionState(connection);
    const detail = channel.connectorId === "wechat" && connection.status === "unavailable" && connection.healthMessage === "Not available / Not configured"
      ? "暂不可用 / 未配置" : connection.healthMessage;
    return { ...connection, ...channel, state, stateLabel: stateLabels[state], detail, actionLabel: actionLabel(state) };
  });
}
