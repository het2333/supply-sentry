import { ReadyworkApiError } from "../shared/api-client";

type Row = Record<string, unknown>;

export type PoChatSuggestedAction = {
  id: string;
  label: string;
  description: string;
  actionId: string;
  targetTab: "overview";
  requiresConfirmation: true;
};

export type PoChatAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  securityStatus: string;
  processingStatus: string;
  detectedContentType: string | null;
  createdAt: string;
  readableByModel: boolean;
};

export type PoChatMessage = {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  status: "completed" | "failed";
  model: string | null;
  modelRoute: string | null;
  usage: Record<string, number> | null;
  attachment: PoChatAttachment | null;
  suggestedActions: PoChatSuggestedAction[];
  createdAt: string;
};

export type PoChatPayload = {
  conversation: null | {
    id: string;
    purchaseOrderId: string;
    status: "active" | "archived";
    version: number;
    lastSequence: number;
    createdAt: string;
    updatedAt: string;
  };
  messages: PoChatMessage[];
  suggestedActions: PoChatSuggestedAction[];
  contextSummary: {
    purchaseOrderId: string;
    displayNumber: string;
    status: string | null;
    supplierId: string | null;
  };
  model: {
    configured: boolean;
    route: "fast" | "reasoning" | null;
    name: string | null;
    maxTokens: number | null;
  };
};

const isRow = (value: unknown): value is Row => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, fallback = "") => typeof value === "string" && value.trim() ? value : fallback;
const number = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

function normalizeAction(value: unknown): PoChatSuggestedAction | null {
  if (!isRow(value) || value["requiresConfirmation"] !== true || value["targetTab"] !== "overview") return null;
  const id = text(value["id"]);
  const label = text(value["label"]);
  const description = text(value["description"]);
  const actionId = text(value["actionId"]);
  return id && label && description && actionId ? { id, label, description, actionId, targetTab: "overview", requiresConfirmation: true } : null;
}

function normalizeAttachment(value: unknown): PoChatAttachment | null {
  if (!isRow(value)) return null;
  const id = text(value["id"]);
  if (!id) return null;
  return {
    id,
    fileName: text(value["fileName"], "未命名附件"),
    contentType: text(value["contentType"], "application/octet-stream"),
    sizeBytes: number(value["sizeBytes"]),
    sha256: text(value["sha256"]),
    securityStatus: text(value["securityStatus"], "unknown"),
    processingStatus: text(value["processingStatus"], "unknown"),
    detectedContentType: text(value["detectedContentType"]) || null,
    createdAt: text(value["createdAt"]),
    readableByModel: value["readableByModel"] === true,
  };
}

function normalizeUsage(value: unknown): Record<string, number> | null {
  if (!isRow(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]));
  return entries.length ? Object.fromEntries(entries) : null;
}

function normalizeMessage(value: unknown): PoChatMessage | null {
  if (!isRow(value) || (value["role"] !== "user" && value["role"] !== "assistant")) return null;
  const id = text(value["id"]);
  const content = text(value["content"]);
  const sequence = number(value["sequence"], -1);
  if (!id || !content || sequence < 1) return null;
  return {
    id,
    sequence,
    role: value["role"],
    content,
    status: value["status"] === "failed" ? "failed" : "completed",
    model: text(value["model"]) || null,
    modelRoute: text(value["modelRoute"]) || null,
    usage: normalizeUsage(value["usage"]),
    attachment: normalizeAttachment(value["attachment"]),
    suggestedActions: Array.isArray(value["suggestedActions"]) ? value["suggestedActions"].map(normalizeAction).filter((item): item is PoChatSuggestedAction => item !== null) : [],
    createdAt: text(value["createdAt"]),
  };
}

export function normalizePoChatPayload(value: unknown): PoChatPayload {
  if (!isRow(value) || !Array.isArray(value["messages"]) || !isRow(value["contextSummary"]) || !isRow(value["model"])) {
    throw new Error("PO 聊天接口返回无效数据");
  }
  const conversationValue = value["conversation"];
  let conversation: PoChatPayload["conversation"] = null;
  if (conversationValue !== null) {
    if (!isRow(conversationValue)) throw new Error("PO 聊天会话数据无效");
    const id = text(conversationValue["id"]);
    const purchaseOrderId = text(conversationValue["purchaseOrderId"]);
    if (!id || !purchaseOrderId) throw new Error("PO 聊天会话数据无效");
    conversation = {
      id,
      purchaseOrderId,
      status: conversationValue["status"] === "archived" ? "archived" : "active",
      version: number(conversationValue["version"]),
      lastSequence: number(conversationValue["lastSequence"]),
      createdAt: text(conversationValue["createdAt"]),
      updatedAt: text(conversationValue["updatedAt"]),
    };
  }
  const messages = value["messages"].map(normalizeMessage).filter((item): item is PoChatMessage => item !== null).sort((left, right) => left.sequence - right.sequence);
  if (messages.length !== value["messages"].length) throw new Error("PO 聊天消息数据无效");
  const summary = value["contextSummary"];
  const model = value["model"];
  const explicitActions = Array.isArray(value["suggestedActions"])
    ? value["suggestedActions"].map(normalizeAction).filter((item): item is PoChatSuggestedAction => item !== null)
    : [];
  const latestAssistantActions = [...messages].reverse().find((message) => message.role === "assistant")?.suggestedActions ?? [];
  return {
    conversation,
    messages,
    suggestedActions: explicitActions.length ? explicitActions : latestAssistantActions,
    contextSummary: {
      purchaseOrderId: text(summary["purchaseOrderId"]),
      displayNumber: text(summary["displayNumber"], text(summary["purchaseOrderId"])),
      status: text(summary["status"]) || null,
      supplierId: text(summary["supplierId"]) || null,
    },
    model: {
      configured: model["configured"] === true,
      route: model["route"] === "fast" || model["route"] === "reasoning" ? model["route"] : null,
      name: text(model["name"]) || null,
      maxTokens: typeof model["maxTokens"] === "number" && Number.isFinite(model["maxTokens"]) ? model["maxTokens"] : null,
    },
  };
}

export type PoChatAttachmentState = "pending" | "ready" | "blocked";

export function poChatAttachmentState(attachment: PoChatAttachment): PoChatAttachmentState {
  if (attachment.securityStatus === "clean" && attachment.processingStatus === "parsed" && attachment.readableByModel) return "ready";
  if (["quarantined", "rejected"].includes(attachment.securityStatus) || ["parse_failed", "rejected"].includes(attachment.processingStatus)) return "blocked";
  return "pending";
}

function apiCode(error: ReadyworkApiError): string {
  return isRow(error.payload) ? text(error.payload["code"]) : "";
}

export function poChatErrorMessage(error: unknown): string {
  if (!(error instanceof ReadyworkApiError)) return error instanceof Error ? error.message : "PO 上下文聊天暂时不可用";
  const code = apiCode(error);
  if (error.status === 401) return "登录已过期，请重新登录后再读取 PO 聊天。";
  if (error.status === 403) return "当前身份没有使用 PO 上下文聊天的权限。";
  if (error.status === 404) return "该 PO 或当前用户的会话不存在，请重新选择订单。";
  if (code === "PO_CHAT_CONVERSATION_BUSY") return "上一条回答仍在生成，请稍后刷新。";
  if (code === "PO_CHAT_VERSION_CONFLICT" || code === "PO_CHAT_HISTORY_CONFLICT") return "会话已被其他页面更新，正在重新读取持久化历史。";
  if (code === "IDEMPOTENCY_KEY_REUSED") return "本次消息内容已变化，请重新发送。";
  if (error.status === 413) return error.message || "附件超过允许大小。";
  if (error.status === 408 || error.status === 0) return "回答结果暂时未确认；消息可能仍在后端处理，请先刷新历史。";
  return error.message || `PO 聊天请求失败（${error.status}）`;
}
