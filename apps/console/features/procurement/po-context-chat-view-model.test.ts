import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReadyworkApiError } from "../shared/api-client";
import { normalizePoChatPayload, poChatAttachmentState, poChatErrorMessage } from "./po-context-chat-view-model";

const base = {
  conversation: null,
  messages: [],
  suggestedActions: [],
  contextSummary: { purchaseOrderId: "po:1", displayNumber: "P00001", status: "awaiting_confirmation", supplierId: "supplier:1" },
  model: { configured: true },
};

describe("PO 上下文聊天前端状态", () => {
  it("接受无会话的真实空状态", () => {
    const view = normalizePoChatPayload(base);
    assert.equal(view.conversation, null);
    assert.deepEqual(view.messages, []);
    assert.equal(view.contextSummary.displayNumber, "P00001");
  });

  it("保留 SQLite 有序历史、模型用量与结构化建议", () => {
    const view = normalizePoChatPayload({
      ...base,
      conversation: { id: "chat:1", purchaseOrderId: "po:1", status: "active", version: 1, lastSequence: 2, createdAt: "2026-08-30", updatedAt: "2026-08-30" },
      messages: [
        { id: "m:2", sequence: 2, role: "assistant", content: "已读取 PO。", status: "completed", model: "deepseek", modelRoute: "fast", usage: { prompt_tokens: 120 }, attachment: null, suggestedActions: [{ id: "a:1", label: "再次催确认", description: "转到概览核对后操作", actionId: "followup-confirm", targetTab: "overview", requiresConfirmation: true }], createdAt: "2026-08-30" },
        { id: "m:1", sequence: 1, role: "user", content: "当前阶段？", status: "completed", attachment: null, suggestedActions: [], createdAt: "2026-08-30" },
      ],
    });
    assert.deepEqual(view.messages.map((message) => message.sequence), [1, 2]);
    assert.equal(view.messages[1]?.usage?.["prompt_tokens"], 120);
    assert.equal(view.suggestedActions[0]?.actionId, "followup-confirm");
  });

  it("区分附件等待扫描、可供模型读取和安全阻断", () => {
    const pending = { id: "f:1", fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 10, sha256: "x", securityStatus: "pending_scan", processingStatus: "queued", detectedContentType: null, createdAt: "", readableByModel: false };
    assert.equal(poChatAttachmentState(pending), "pending");
    assert.equal(poChatAttachmentState({ ...pending, securityStatus: "clean", processingStatus: "parsed", readableByModel: true }), "ready");
    assert.equal(poChatAttachmentState({ ...pending, securityStatus: "quarantined", processingStatus: "parse_failed" }), "blocked");
  });

  it("把模型失败保留为持久化失败消息", () => {
    const view = normalizePoChatPayload({ ...base, messages: [{ id: "m:1", sequence: 1, role: "assistant", content: "模型服务暂时不可用", status: "failed", model: "deepseek", modelRoute: "reasoning", usage: null, attachment: null, suggestedActions: [], createdAt: "2026-08-30" }] });
    assert.equal(view.messages[0]?.status, "failed");
  });

  it("为 401 与 409 返回可恢复提示", () => {
    assert.match(poChatErrorMessage(new ReadyworkApiError("未登录", 401, { code: "UNAUTHORIZED" })), /登录已过期/);
    assert.match(poChatErrorMessage(new ReadyworkApiError("冲突", 409, { code: "PO_CHAT_VERSION_CONFLICT" })), /重新读取/);
  });
});
