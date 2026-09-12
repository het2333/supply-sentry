import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = readFileSync(
  fileURLToPath(new URL("../features/procurement/configuration-workbench.tsx", import.meta.url)),
  "utf8",
);
const pageSource = readFileSync(
  fileURLToPath(new URL("../app/page.tsx", import.meta.url)),
  "utf8",
);
const channelSource = readFileSync(
  fileURLToPath(new URL("../features/procurement/channel-connections-panel.tsx", import.meta.url)),
  "utf8",
);
const preferencesSource = readFileSync(
  fileURLToPath(new URL("../features/procurement/tenant-preferences-panel.tsx", import.meta.url)),
  "utf8",
);
const readinessSource = readFileSync(
  fileURLToPath(new URL("../features/procurement/v1-readiness-panel.tsx", import.meta.url)),
  "utf8",
);

test("Configuration Web: 使用客户结果优先和渐进披露骨架", () => {
  assert.match(source, />自动跟单设置</);
  assert.match(source, /configuration-readiness-summary/);
  assert.match(source, /preferencesOpen/);
  assert.match(source, /moreChannelsOpen/);
  assert.match(source, /diagnosticsOpen/);
  assert.match(source, /preferencesOpen \? <div id="tenant-preferences-disclosure"/);
  assert.match(source, /moreChannelsOpen \? <div id="more-messaging-channels"/);
  assert.match(source, /diagnosticsOpen \? <div id="messaging-system-diagnostics"/);
  assert.match(source, /READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS/);
  assert.match(source, /advancedOpen/);
  assert.match(source, /max-w-\[1540px\]/);
});

test("Configuration Web: 通信首屏仅保留 Email 和 WhatsApp，个人微信交给 Hermes 扫码入口", () => {
  assert.match(source, /category="communication"/);
  assert.match(source, /category="business"/);
  assert.match(channelSource, /Meta WhatsApp Cloud API/);
  assert.match(source, /个人微信和其他消息渠道/);
  assert.match(source, /个人微信可直接扫码接入/);
  assert.match(channelSource, /data-preserve-language/);
  assert.doesNotMatch(channelSource, /\bQR\b|pairing|Linked Devices/i);
  assert.match(source, /id="business-systems"/);
});

test("Configuration Web: auto-send 展示 profile、allowlist、双权限、identity、target、connector 与 kill switch 的真实阻断", () => {
  assert.match(source, /autoSend/);
  for (const id of ["permission", "published_profile", "communication_identity", "allowlists", "supplier_target", "connector", "kill_switch"]) {
    assert.match(source, new RegExp(id));
  }
  assert.match(source, /启用后，命中允许列表且通过全部服务端门禁的消息可绕过邮件草稿人工队列/);
});

test("Configuration Web: 重用真实租户、连接、身份、部署和发布核验组件", () => {
  assert.match(source, /ProcurementTenantPreferencesPanel/);
  assert.match(source, /ProcurementChannelConnectionsPanel/);
  assert.match(source, /ProcurementCommunicationIdentityPanel/);
  assert.match(source, /ProcurementDeploymentProfilePanel/);
  assert.match(source, /ProcurementV1ReadinessPanel/);
  assert.doesNotMatch(source, /useEffect\([\s\S]*setTimeout/);
});

test("Configuration Web: page 不再直接铺开设置组件且保留工具页共用控制面", () => {
  assert.match(pageSource, /<ProcurementConfigurationWorkbench/);
  assert.match(pageSource, /mode=\{section === "settings" \? "settings" : "tools"\}/);
  assert.match(pageSource, /procurementSection \? <ProcurementGlobalHeader/);
  assert.doesNotMatch(pageSource, /section === "settings" \? null : <ProcurementGlobalHeader/);
  assert.doesNotMatch(pageSource, /section === "settings" && <ProcurementTenantPreferencesPanel/);
  assert.match(pageSource, /id="connector-control-plane"/);
});

test("Configuration Web: 账号断开必须经过真实 DELETE、确认和服务端成功刷新", () => {
  assert.match(pageSource, /credentialPendingDisconnect/);
  assert.match(pageSource, /method: "DELETE"/);
  assert.match(pageSource, /await loadConnectors\(\)/);
  assert.match(pageSource, /断开 WhatsApp 账号/);
  assert.match(pageSource, /不会撤销 Meta 端的 WhatsApp Business 账号/);
  assert.match(pageSource, /credentialDisconnectError/);
  assert.match(pageSource, /正在断开…/);
  assert.match(pageSource, /requestConnectorDisconnect/);
  assert.match(channelSource, /onDisconnect\(actionableConnector\)/);
  assert.match(channelSource, /item\.connectorId === "whatsapp" \? "断开账号" : "断开连接"/);
  assert.doesNotMatch(pageSource, /setCredentialPendingDisconnect\(null\);[\s\S]{0,120}await apiRequest/);
});

test("Configuration Web: Agent Setup 直接操作会先展开高级区再定位真实连接器", () => {
  assert.match(source, /pendingConnector/);
  assert.match(source, /setAdvancedOpen\(true\)/);
  assert.match(source, /window\.requestAnimationFrame\(\(\) => onOpenConnector\(connectorId\)\)/);
  assert.match(channelSource, /grid items-start gap-5/);
  assert.match(channelSource, /min-h-\[276px\]/);
});

test("Configuration Web: 非管理员读取脱敏连接摘要，不把 403 伪装成连接器不存在", () => {
  assert.match(pageSource, /\/api\/procurement\/configuration\/connections/);
  assert.match(pageSource, /configurationConnectionsManageable/);
  assert.match(source, /connectionsManageable/);
  assert.match(channelSource, /当前角色可查看真实连接状态/);
  assert.match(channelSource, /保存凭据、运行外部测试和断开连接仍需要管理员权限/);
  assert.match(channelSource, /已验证 · 由管理员管理/);
  assert.match(channelSource, /联系管理员配置/);
  assert.match(channelSource, /disabled/);
  assert.match(source, /管理员治理控制面/);
  assert.match(source, /权限不足不会再显示成 0 条记录/);
  assert.match(source, /connectionsManageable \? children : administrationBoundary/);
  assert.match(pageSource, /configurationConnectionsManageable\) \{[\s\S]*void loadConnectors\(\)/);
  assert.match(pageSource, /setConnectorError\(null\)/);
  assert.match(readinessSource, /operationsManageable/);
  assert.match(readinessSource, /当前角色读取的是同一持久化事实生成的脱敏发布摘要/);
  assert.match(readinessSource, /管理员治理/);
  assert.doesNotMatch(readinessSource, /\/api\/operations\/readiness/);
});

test("Configuration Web: General Settings 四项开关提交真实版本化策略而不是本地假状态", () => {
  for (const label of ["启用 SLA 升级", "排除周末", "排除公共节假日", "自动计算交期"]) {
    assert.match(preferencesSource, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(preferencesSource, /role="switch"/);
  assert.match(preferencesSource, /expectedVersion: data\.item\?\.version \?\? 0/);
  assert.match(preferencesSource, /slaEscalationsEnabled,/);
  assert.match(preferencesSource, /excludeWeekends,/);
  assert.match(preferencesSource, /excludePublicHolidays,/);
  assert.match(preferencesSource, /autoCalculateLeadTime,/);
  assert.match(preferencesSource, /apiRequest<PreferencesResponse>\("\/api\/procurement\/tenant-preferences"/);
  assert.doesNotMatch(preferencesSource, /localStorage|setTimeout/);
});
