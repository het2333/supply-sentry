import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const routeChatSource = readFileSync(
  fileURLToPath(new URL("../features/procurement/route-chat.tsx", import.meta.url)),
  "utf8",
);
const workbenchSource = readFileSync(
  fileURLToPath(new URL("../features/procurement/route-workbench.tsx", import.meta.url)),
  "utf8",
);
const viewModelSource = readFileSync(
  fileURLToPath(new URL("../features/procurement/route-chat-view-model.ts", import.meta.url)),
  "utf8",
);

test("Route Assistant: 1280/1440/1920 仅验证桌面双栏边界", () => {
  for (const viewportWidth of [1280, 1440, 1920]) {
    assert.ok(viewportWidth >= 1140);
    assert.match(workbenchSource, /min-w-\[1140px\]/);
    assert.match(workbenchSource, /grid-cols-\[380px_minmax\(0,1fr\)\]/);
  }
  assert.match(workbenchSource, /h-\[calc\(100vh-176px\)\]/);
  assert.match(workbenchSource, /sticky top-\[100px\]/);
  assert.doesNotMatch(workbenchSource, /bottom-nav|mobile-nav|useMediaQuery|window\.matchMedia/);
});

test("Route Assistant: normal / expanded / closed 三种桌面模式保留入口", () => {
  assert.match(workbenchSource, /useState<"normal" \| "expanded" \| "closed">/);
  assert.match(workbenchSource, /assistantMode === "expanded"/);
  assert.match(workbenchSource, /assistantMode === "closed"/);
  assert.match(workbenchSource, /grid-cols-\[minmax\(500px,0\.95fr\)_minmax\(0,1\.05fr\)\]/);
  assert.match(routeChatSource, /mode === "expanded"/);
  assert.match(routeChatSource, /aria-label="新建对话"/);
  assert.match(routeChatSource, /aria-label="关闭助理"/);
  assert.match(workbenchSource, /PanelLeftOpen/);
  assert.match(workbenchSource, /fixed bottom-6 right-6/);
  assert.match(workbenchSource, />Readywork 助理<\/button>/);
});

test("Route Assistant: 初始内容对齐公开桌面骨架但不伪造业务能力", () => {
  assert.match(routeChatSource, />您好！👋</);
  assert.doesNotMatch(routeChatSource, /管理员，您好/);
  assert.match(routeChatSource, /assistantCapabilities\[route\]/);
  assert.match(routeChatSource, /欢迎询问您的\{title\}/);
  assert.match(routeChatSource, /采购订单状态与详情/);
  assert.match(routeChatSource, /采购支出分析/);
  assert.match(routeChatSource, /按供应商查看采购订单/);
  assert.match(routeChatSource, /询问关于\$\{route === "local" \? "本地" : "进口"\}采购订单的问题…/);
  assert.match(routeChatSource, /Readywork 助理可能出错，请核对重要信息。/);
  assert.doesNotMatch(`${routeChatSource}\n${workbenchSource}`, /Navi Assistant/);
  assert.match(routeChatSource, /rounded-2xl bg-\[#f7f8ff\]/);
  assert.match(routeChatSource, /刷新历史/);
  assert.match(routeChatSource, /slice\(0, 4\)/);
  assert.match(routeChatSource, /rounded-lg border border-\[#dfe6ef\]/);
});

test("Route Assistant: 空态、错误态与只读态有明确契约", () => {
  assert.match(routeChatSource, /!data\?\.messages\.length/);
  assert.match(routeChatSource, /role="alert"/);
  assert.match(routeChatSource, /data\?\.permissions\.operate !== true/);
  assert.match(routeChatSource, /当前身份只有读取权限/);
  assert.match(routeChatSource, /routeChatErrorMessage/);
  assert.match(routeChatSource, /读取持久化路线会话…/);
  assert.match(viewModelSource, /permissions: \{ operate: permissionsValue\["operate"\] === true \}/);
});

test("Route Assistant: 新对话走后端 startNew，附件入口对接真实 multipart 合同", () => {
  assert.match(routeChatSource, /startNew: newConversation/);
  assert.match(routeChatSource, /setData\(\(current\) => current \? \{ \.\.\.current, conversation: null, messages: \[\]/);
  assert.match(routeChatSource, /Paperclip/);
  assert.match(routeChatSource, /new FormData\(\)/);
  assert.match(routeChatSource, /form\.set\(data\.capabilities\.attachments\.field, file\)/);
  assert.match(routeChatSource, /accept=\{attachmentAccept\}/);
  assert.match(routeChatSource, /重试解析/);
  assert.match(routeChatSource, /移除待发送附件/);
  assert.match(routeChatSource, /onClick=\{\(\) => \{ resetIdempotency\(\); void sendMessage\(question\); \}\}/);
  assert.match(viewModelSource, /attachmentsValue\["supported"\] === true/);
  assert.match(viewModelSource, /field: "file"/);
});
