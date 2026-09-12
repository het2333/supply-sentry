import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReadyworkApiError } from "../shared/api-client";
import { normalizeRouteChatPayload, routeChatAttachmentState, routeChatErrorMessage } from "./route-chat-view-model";

const base = {
  conversation: null,
  messages: [],
  suggestedQuestions: ["查看高风险 PO"],
  permissions: { operate: true },
  capabilities: { attachments: { supported: false, reason: "仅支持文本消息" } },
  model: { configured: true, route: "fast" },
};

describe("路线级 Navi Assistant 前端状态", () => {
  it("保留真实空会话、建议问题与权限能力", () => {
    const view = normalizeRouteChatPayload(base, "local");
    assert.deepEqual(view.messages, []);
    assert.equal(view.suggestedQuestions[0], "查看高风险 PO");
    assert.equal(view.permissions.operate, true);
    assert.equal(view.capabilities.attachments.supported, false);
    assert.equal(view.capabilities.attachments.reason, "仅支持文本消息");
  });

  it("按 sequence 保留持久化消息并适配 suggestion 对象", () => {
    const view = normalizeRouteChatPayload({
      ...base,
      suggestions: [{ label: "查看清关异常" }],
      messages: [
        { id: "m2", sequence: 2, role: "assistant", content: "已读取真实路线事实", status: "completed", modelRoute: "reasoning", usage: { completion_tokens: 20 }, createdAt: "2026-09-01" },
        { id: "m1", sequence: 1, role: "user", content: "有哪些风险？", createdAt: "2026-09-01" },
      ],
      conversation: { id: "route-chat:1", route: "import", status: "active", version: 2, lastSequence: 2 },
      permissions: { operate: false },
      capabilities: { attachments: { supported: false, reason: "附件未启用" } },
    }, "import");
    assert.deepEqual(view.messages.map((message) => message.sequence), [1, 2]);
    assert.equal(view.suggestedQuestions.includes("查看清关异常"), true);
    assert.equal(view.permissions.operate, false);
    assert.equal(view.capabilities.attachments.reason, "附件未启用");
    assert.equal(view.conversation?.route, "import");
  });

  it("缺少 operate 权限时安全地禁止发送", () => {
    const view = normalizeRouteChatPayload({ ...base, permissions: {} }, "local");
    assert.equal(view.permissions.operate, false);
  });

  it("为权限、冲突与超时返回可恢复提示", () => {
    assert.match(routeChatErrorMessage(new ReadyworkApiError("禁止", 403)), /没有使用路线助手/);
    assert.match(routeChatErrorMessage(new ReadyworkApiError("冲突", 409, { code: "ROUTE_CHAT_VERSION_CONFLICT" })), /重新读取/);
    assert.match(routeChatErrorMessage(new ReadyworkApiError("超时", 408)), /暂时未确认/);
  });

  it("保留真实附件状态、能力上限与安全门禁", () => {
    const view = normalizeRouteChatPayload({
      ...base,
      capabilities: { attachments: { supported: true, field: "file", accept: [".pdf", ".csv", ".xlsx", ".docx", ".txt", ".md"], maxBytes: 8 * 1024 * 1024, multipart: true } },
      messages: [{ id: "m1", sequence: 1, role: "user", content: "请核对附件", attachment: { id: "attachment:1", fileName: "route.md", contentType: "text/markdown", sizeBytes: 12, sha256: "a".repeat(64), securityStatus: "pending_scan", processingStatus: "queued", detectedContentType: null, createdAt: "2026-09-01", readableByModel: false } }],
    }, "local");
    assert.equal(view.capabilities.attachments.supported, true);
    assert.equal(view.capabilities.attachments.field, "file");
    assert.deepEqual(view.capabilities.attachments.accept, [".pdf", ".csv", ".xlsx", ".docx", ".txt", ".md"]);
    assert.equal(routeChatAttachmentState(view.messages[0]!.attachment!), "pending");
    assert.equal(routeChatAttachmentState({ ...view.messages[0]!.attachment!, securityStatus: "clean", processingStatus: "parsed", readableByModel: true }), "ready");
    assert.equal(routeChatAttachmentState({ ...view.messages[0]!.attachment!, securityStatus: "clean", processingStatus: "parse_failed" }), "blocked");
  });
});
