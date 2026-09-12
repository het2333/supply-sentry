import { ReadyworkApiError } from "../shared/api-client";

type Row = Record<string, unknown>;

export type RouteChatRoute = "local" | "import";

export type RouteChatMessage = {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  status: "completed" | "failed";
  model: string | null;
  modelRoute: string | null;
  usage: Record<string, number> | null;
  attachment: null | {
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
  createdAt: string;
};

export type RouteChatPayload = {
  conversation: null | {
    id: string;
    route: RouteChatRoute;
    status: "active" | "archived";
    version: number;
    lastSequence: number;
    createdAt: string;
    updatedAt: string;
  };
  messages: RouteChatMessage[];
  suggestedQuestions: string[];
  permissions: { operate: boolean };
  capabilities: { attachments: { supported: boolean; reason: string | null; field: "file"; accept: string[]; maxBytes: number; multipart: boolean } };
  model: {
    configured: boolean;
    route: "fast" | "reasoning" | null;
    name: string | null;
    maxTokens: number | null;
  };
};

export type RouteChatAttachmentState = "pending" | "ready" | "blocked";

export function routeChatAttachmentState(attachment: NonNullable<RouteChatMessage["attachment"]>): RouteChatAttachmentState {
  if (attachment.securityStatus === "clean" && attachment.processingStatus === "parsed" && attachment.readableByModel) return "ready";
  if (["quarantined", "rejected", "scan_failed"].includes(attachment.securityStatus) || ["parse_failed", "rejected"].includes(attachment.processingStatus)) return "blocked";
  return "pending";
}

const isRow = (value: unknown): value is Row => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, fallback = "") => typeof value === "string" && value.trim() ? value : fallback;
const number = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;

function normalizeAttachment(value: unknown): RouteChatMessage["attachment"] {
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

function normalizeMessage(value: unknown): RouteChatMessage | null {
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
    createdAt: text(value["createdAt"]),
  };
}

function normalizeQuestion(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (isRow(value)) {
    const question = text(value["question"], text(value["label"], text(value["prompt"])));
    return question || null;
  }
  return null;
}

/** Route chat intentionally accepts small contract differences while keeping persisted history strict. */
export function normalizeRouteChatPayload(value: unknown, route: RouteChatRoute): RouteChatPayload {
  if (!isRow(value) || !Array.isArray(value["messages"])) throw new Error("路线助手接口返回无效数据");

  const conversationValue = value["conversation"];
  let conversation: RouteChatPayload["conversation"] = null;
  if (conversationValue !== null && conversationValue !== undefined) {
    if (!isRow(conversationValue)) throw new Error("路线助手会话数据无效");
    const id = text(conversationValue["id"]);
    if (!id) throw new Error("路线助手会话数据无效");
    conversation = {
      id,
      route: conversationValue["route"] === "import" ? "import" : route,
      status: conversationValue["status"] === "archived" ? "archived" : "active",
      version: number(conversationValue["version"]),
      lastSequence: number(conversationValue["lastSequence"]),
      createdAt: text(conversationValue["createdAt"]),
      updatedAt: text(conversationValue["updatedAt"]),
    };
  }

  const messages = value["messages"].map(normalizeMessage).filter((item): item is RouteChatMessage => item !== null).sort((left, right) => left.sequence - right.sequence);
  if (messages.length !== value["messages"].length) throw new Error("路线助手消息数据无效");

  const questionValues = [
    ...(Array.isArray(value["suggestedQuestions"]) ? value["suggestedQuestions"] : []),
    ...(Array.isArray(value["suggestions"]) ? value["suggestions"] : []),
    ...(Array.isArray(value["suggestedPrompts"]) ? value["suggestedPrompts"] : []),
  ];
  const suggestedQuestions = [...new Set(questionValues.map(normalizeQuestion).filter((item): item is string => item !== null))];
  const modelValue = isRow(value["model"]) ? value["model"] : {};
  const permissionsValue = isRow(value["permissions"]) ? value["permissions"] : {};
  const capabilitiesValue = isRow(value["capabilities"])
    ? value["capabilities"]
    : isRow(value["features"])
      ? value["features"]
      : {};
  const attachmentsValue = isRow(capabilitiesValue["attachments"]) ? capabilitiesValue["attachments"] : null;
  const acceptedExtensions = attachmentsValue && Array.isArray(attachmentsValue["accept"])
    ? attachmentsValue["accept"].filter((item): item is string => typeof item === "string")
    : [".pdf", ".csv", ".xlsx", ".docx", ".txt", ".md"];
  return {
    conversation,
    messages,
    suggestedQuestions,
    permissions: { operate: permissionsValue["operate"] === true },
    capabilities: {
      attachments: {
        supported: attachmentsValue ? attachmentsValue["supported"] === true : capabilitiesValue["attachments"] === true,
        reason: attachmentsValue
          ? text(attachmentsValue["reason"]) || null
          : capabilitiesValue["attachments"] === true
            ? null
            : "路线助手当前仅支持文本消息",
        field: "file",
        accept: acceptedExtensions,
        maxBytes: attachmentsValue && typeof attachmentsValue["maxBytes"] === "number" && Number.isFinite(attachmentsValue["maxBytes"]) ? attachmentsValue["maxBytes"] : 8 * 1024 * 1024,
        multipart: attachmentsValue ? attachmentsValue["multipart"] === true : false,
      },
    },
    model: {
      configured: modelValue["configured"] === true,
      route: modelValue["route"] === "fast" || modelValue["route"] === "reasoning" ? modelValue["route"] : null,
      name: text(modelValue["name"]) || null,
      maxTokens: typeof modelValue["maxTokens"] === "number" && Number.isFinite(modelValue["maxTokens"]) ? modelValue["maxTokens"] : null,
    },
  };
}

function apiCode(error: ReadyworkApiError): string {
  return isRow(error.payload) ? text(error.payload["code"]) : "";
}

export function routeChatErrorMessage(error: unknown): string {
  if (!(error instanceof ReadyworkApiError)) return error instanceof Error ? error.message : "路线助手暂时不可用";
  const code = apiCode(error);
  if (error.status === 401) return "登录已过期，请重新登录后再读取路线助手。";
  if (error.status === 403) return "当前身份没有使用路线助手的权限。";
  if (error.status === 404) return "该采购路线不存在，请重新选择路线。";
  if (["ROUTE_CHAT_CONVERSATION_BUSY", "ROUTE_CHAT_BUSY"].includes(code)) return "上一条回答仍在生成，请稍后刷新。";
  if (["ROUTE_CHAT_VERSION_CONFLICT", "ROUTE_CHAT_HISTORY_CONFLICT"].includes(code)) return "会话已被其他页面更新，正在重新读取持久化历史。";
  if (code === "IDEMPOTENCY_KEY_REUSED") return "本次消息内容已变化，请重新发送。";
  if (error.status === 408 || error.status === 0) return "回答结果暂时未确认；消息可能仍在后端处理，请先刷新历史。";
  return error.message || `路线助手请求失败（${error.status}）`;
}
