import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChannelConnectionViews } from "../features/procurement/channel-connections-view-model.js";

test("Configuration channel summary derives truth from connector and credential facts", () => {
  const views = buildChannelConnectionViews([
    { id: "email", connectionType: "SMTP / IMAP", status: "installed", runtimeHealthy: true, credentialReady: true, externalVerified: true, credentialCount: 1, lastTestedAt: "2026-08-31T08:00:00.000Z", healthMessage: "SMTP / IMAP 已验证" },
    { id: "whatsapp", connectionType: "Meta WhatsApp Cloud API", status: "installed", runtimeHealthy: true, credentialReady: true, externalVerified: false, credentialCount: 1, lastTestedAt: null, healthMessage: "等待真实测试" },
    { id: "wechat", connectionType: "Not available", status: "unavailable", runtimeHealthy: false, credentialReady: false, externalVerified: false, credentialCount: 0, lastTestedAt: null, healthMessage: "Not available / Not configured" },
    { id: "deepseek", connectionType: "DeepSeek API", status: "failed", runtimeHealthy: false, credentialReady: true, externalVerified: false, credentialCount: 1, lastTestedAt: "2026-08-31T08:05:00.000Z", healthMessage: "DeepSeek API 密钥无效" },
    { id: "erp", connectionType: "Odoo ERP", status: "failed", runtimeHealthy: false, credentialReady: true, externalVerified: false, credentialCount: 1, lastTestedAt: "2026-08-31T08:10:00.000Z", healthMessage: "Odoo 认证失败" },
  ]);

  assert.deepEqual(views.map((item) => [item.connectorId, item.state, item.actionLabel]), [
    ["email", "connected", "查看连接"],
    ["whatsapp", "test_required", "去测试连接"],
    ["deepseek", "attention", "修复连接"],
    ["erp", "attention", "修复连接"],
  ]);
  assert.deepEqual(views.map((item) => item.title), ["邮件智能体", "WhatsApp 智能体", "DeepSeek AI", "ERP / Odoo"]);
  assert.match(views[0]!.description, /已验证的公司邮箱/);
  assert.equal(views[1]!.connectionType, "Meta WhatsApp Cloud API");
  assert.match(views[2]!.detail, /DeepSeek API 密钥无效/);
  assert.match(views[3]!.detail, /Odoo 认证失败/);
  assert.equal(views[0]!.lastTestedAt, "2026-08-31T08:00:00.000Z");
});

test("Configuration channel summary never invents readiness for missing or disabled connectors", () => {
  const views = buildChannelConnectionViews([
    { id: "email", connectionType: "SMTP / IMAP", status: "disabled", runtimeHealthy: false, credentialReady: true, externalVerified: false, credentialCount: 1, lastTestedAt: null, healthMessage: "已停用" },
    { id: "erp", connectionType: "Odoo ERP", status: "available", runtimeHealthy: false, credentialReady: false, externalVerified: false, credentialCount: 0, lastTestedAt: null, healthMessage: "未安装" },
  ]);
  assert.equal(views.find((item) => item.connectorId === "email")?.state, "disabled");
  assert.equal(views.find((item) => item.connectorId === "whatsapp")?.state, "unavailable");
  assert.equal(views.find((item) => item.connectorId === "wechat"), undefined);
  assert.equal(views.find((item) => item.connectorId === "erp")?.state, "setup_required");
});
