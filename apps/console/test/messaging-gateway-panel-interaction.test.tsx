import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://readywork.test/" });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = value;
  }
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: globals.requestAnimationFrame });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: globals.cancelAnimationFrame });
  return { host: dom.window.document.querySelector<HTMLDivElement>("#root")!, restore: () => { for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value; dom.window.close(); } };
}

const wait = () => new Promise((resolve) => setTimeout(resolve, 0));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const setTextarea = (textarea: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};
const setInput = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

function hermesCatalog(stale = false) {
  return {
    stale,
    capturedAt: "2026-09-09T10:00:00.000Z",
    permissions: { manage: true },
    platforms: [
      {
        id: "signal", name: "Signal", description: "Secure messaging", docsUrl: "https://example.test/signal",
        enabled: true, configured: false, gatewayRunning: true, state: "not_configured", errorCode: null,
        errorMessage: null, updatedAt: null, onboarding: null,
        envVars: [{ key: "SIGNAL_TOKEN", required: true, isSet: true, description: "Token", prompt: "Token", help: "", url: null, isPassword: true, advanced: false }],
      },
      {
        id: "telegram", name: "Telegram", description: "Telegram bot", docsUrl: "https://example.test/telegram",
        enabled: true, configured: true, gatewayRunning: true, state: "connected", errorCode: null,
        errorMessage: null, updatedAt: "2026-09-09T09:00:00.000Z", onboarding: "telegram", envVars: [],
      },
      {
        id: "discord", name: "Discord", description: "Discord bot", docsUrl: "https://example.test/discord",
        enabled: false, configured: false, gatewayRunning: false, state: "disabled", errorCode: null,
        errorMessage: null, updatedAt: null, onboarding: null, envVars: [],
      },
      {
        id: "future_channel", name: "未来渠道", description: "Dynamic channel", docsUrl: "https://example.test/future",
        enabled: false, configured: false, gatewayRunning: false, state: "disabled", errorCode: null,
        errorMessage: null, updatedAt: null, onboarding: null, envVars: [],
      },
      {
        id: "weixin", name: "Weixin", description: "Personal WeChat", docsUrl: "https://example.test/weixin",
        enabled: false, configured: false, gatewayRunning: true, state: "not_configured", errorCode: null,
        errorMessage: null, updatedAt: null, onboarding: "weixin",
        envVars: [
          { key: "WEIXIN_ACCOUNT_ID", required: true, isSet: false, description: "", prompt: "", help: "", url: null, isPassword: false, advanced: false },
          { key: "WEIXIN_TOKEN", required: true, isSet: false, description: "", prompt: "", help: "", url: null, isPassword: true, advanced: false },
        ],
      },
    ],
  };
}

test("动态 Hermes 渠道目录支持搜索、中文状态、密文不回填、配置与真实连接测试", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let signalConfigured = false;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); requests.push({ path, init });
    if (path === "/api/messaging/platforms" && (!init?.method || init.method === "GET")) {
      const payload = hermesCatalog();
      payload.platforms[0]!.configured = signalConfigured;
      payload.platforms[0]!.state = signalConfigured ? "configured" : "not_configured";
      return Promise.resolve(json(payload));
    }
    if (path === "/api/messaging/hermes/health") return Promise.resolve(json({ status: "running", checkedAt: "2026-09-09T10:00:00.000Z", sidecar: { ok: true }, bridge: { ok: true }, inboxOutbox: { inboxPending: 1, outboxPending: 2, unknownDeliveries: 0 } }));
    if (path === "/api/messaging/gateway") return Promise.resolve(json(gateway("running")));
    if (path === "/api/messaging/platforms/signal" && init?.method === "PUT") { signalConfigured = true; return Promise.resolve(json({ ok: true, platform: "signal" })); }
    if (path === "/api/messaging/platforms/signal/test" && init?.method === "POST") return Promise.resolve(json({ ok: true, state: "connected", message: "渠道连接测试成功" }));
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react"); const { act } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { MessagingGatewayPanel } = await import("../features/procurement/messaging-gateway-panel.js");
    await act(async () => { root = createRoot(host); root.render(<MessagingGatewayPanel />); await wait(); await wait(); });
    assert.match(document.body.textContent ?? "", /消息渠道/);
    assert.equal(document.querySelector("article h3")?.textContent, "微信", "个人微信扫码入口应排在 Hermes 渠道首位");
    assert.match(document.body.textContent ?? "", /信号安全通信/);
    assert.match(document.body.textContent ?? "", /未配置/);
    assert.match(document.body.textContent ?? "", /电报/);
    assert.match(document.body.textContent ?? "", /已连接/);
    const discordCard = [...document.querySelectorAll("article")]
      .find((article) => article.querySelector("h3")?.textContent === "Discord 社群");
    assert.match(discordCard?.textContent ?? "", /未配置/);
    assert.doesNotMatch(discordCard?.textContent ?? "", /无法连接/);
    assert.match(document.body.textContent ?? "", /未来渠道/);

    const search = document.querySelector<HTMLInputElement>("input[aria-label='搜索消息渠道']")!;
    await act(async () => { setInput(search, "信号"); await wait(); });
    assert.match(document.body.textContent ?? "", /信号安全通信/);
    assert.doesNotMatch(document.body.textContent ?? "", /电报/);

    const configure = document.querySelector<HTMLButtonElement>("button[aria-label='配置信号安全通信']")!;
    await act(async () => { configure.click(); await wait(); });
    const secret = document.querySelector<HTMLInputElement>("input[aria-label='信号安全通信：配置项 1']")!;
    assert.equal(secret.value, "", "已保存的密文不得回填");
    assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /已保存/);
    await act(async () => { setInput(secret, "new-secret"); await wait(); });
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "保存渠道配置")!.click(); await wait(); await wait(); });
    const put = requests.find((request) => request.path === "/api/messaging/platforms/signal" && request.init?.method === "PUT")!;
    assert.deepEqual(JSON.parse(String(put.init?.body)), { enabled: true, env: { SIGNAL_TOKEN: "new-secret" }, clearEnv: [] });
    assert.match(new Headers(put.init?.headers).get("Idempotency-Key") ?? "", /^hermes-platform:configure:signal:/);

    await act(async () => { search.value = ""; setInput(search, "信号"); await wait(); });
    await act(async () => { document.querySelector<HTMLButtonElement>("button[aria-label='测试信号安全通信连接']")!.click(); await wait(); await wait(); });
    assert.match(document.body.textContent ?? "", /渠道连接测试成功/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch; restore();
  }
});

test("Hermes 过期快照禁用修改，Telegram 引导会话可从启动走到完成接入", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let stale = true;
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); requests.push({ path, init });
    if (path === "/api/messaging/platforms") return Promise.resolve(json(hermesCatalog(stale)));
    if (path === "/api/messaging/hermes/health") return Promise.resolve(json({ status: stale ? "unreachable" : "running", sidecar: { ok: !stale }, bridge: { ok: !stale }, inboxOutbox: { inboxPending: 0, outboxPending: 0, unknownDeliveries: 0 } }));
    if (path === "/api/messaging/gateway") return Promise.resolve(json(gateway("running")));
    if (path === "/api/messaging/onboarding/telegram/start") return Promise.resolve(json({ pairing_id: "pairing-001", qr_payload: "tg://resolve?domain=readywork", expires_at: "2026-09-09T10:10:00.000Z" }));
    if (path === "/api/messaging/onboarding/telegram/pairing-001") return Promise.resolve(json({ status: "ready", owner_user_id: "123456", bot_username: "readywork_bot" }));
    if (path === "/api/messaging/onboarding/telegram/pairing-001/apply") return Promise.resolve(json({ ok: true, bot_username: "readywork_bot" }));
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react"); const { act } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { MessagingGatewayPanel } = await import("../features/procurement/messaging-gateway-panel.js");
    await act(async () => { root = createRoot(host); root.render(<MessagingGatewayPanel />); await wait(); await wait(); });
    assert.match(document.body.textContent ?? "", /上次成功快照/);
    assert.equal(document.querySelector<HTMLButtonElement>("button[aria-label='配置电报']")?.disabled, true);

    stale = false;
    await act(async () => { document.querySelector<HTMLButtonElement>("button[aria-label='重新读取消息渠道']")!.click(); await wait(); await wait(); });
    await act(async () => { document.querySelector<HTMLButtonElement>("button[aria-label='配置电报']")!.click(); await wait(); });
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "启动扫码接入")!.click(); await wait(); await wait(); });
    assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /等待扫码/);
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "检查扫码结果")!.click(); await wait(); await wait(); });
    assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /账号已确认/);
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "完成接入")!.click(); await wait(); await wait(); });
    const apply = requests.find((request) => request.path.endsWith("/pairing-001/apply"))!;
    assert.deepEqual(JSON.parse(String(apply.init?.body)), { allowed_user_ids: ["123456"] });
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch; restore();
  }
});

test("微信在平台内展示真实二维码，确认后自动保存且不向浏览器泄露凭据", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let resolveWeixinStatus: ((response: Response) => void) | undefined;
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); requests.push({ path, init });
    if (path === "/api/messaging/platforms") return Promise.resolve(json(hermesCatalog(false)));
    if (path === "/api/messaging/hermes/health") return Promise.resolve(json({ status: "running", sidecar: { ok: true }, bridge: { ok: true }, inboxOutbox: { inboxPending: 0, outboxPending: 0, unknownDeliveries: 0 } }));
    if (path === "/api/messaging/gateway") return Promise.resolve(json(gateway("running")));
    if (path === "/api/messaging/onboarding/weixin/start") return Promise.resolve(json({ pairing_id: "weixin-pairing-001", status: "waiting", qr_payload: "https://weixin.example/qr", expires_at: "2026-09-09T10:10:00.000Z" }));
    if (path === "/api/messaging/onboarding/weixin/weixin-pairing-001") return new Promise<Response>((resolve) => { resolveWeixinStatus = resolve; });
    if (path === "/api/messaging/onboarding/weixin/weixin-pairing-001/apply") return Promise.resolve(json({ ok: true, platform: "weixin" }));
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react"); const { act } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { MessagingGatewayPanel } = await import("../features/procurement/messaging-gateway-panel.js");
    await act(async () => { root = createRoot(host); root.render(<MessagingGatewayPanel />); await wait(); await wait(); });
    await act(async () => { document.querySelector<HTMLButtonElement>("button[aria-label='配置微信']")!.click(); await wait(); });
    assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /手机微信扫码/);
    assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /高级手动配置/);
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "生成微信二维码")!.click(); await wait(); await wait(); });
    assert.ok(document.querySelector("svg[aria-label='微信登录二维码']"));
    assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /自动检查扫码结果/);
    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "立即检查")!.click(); await wait(); });
    assert.equal([...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "取消")?.disabled, false, "后台轮询不应锁住关闭和取消");
    await act(async () => { resolveWeixinStatus?.(json({ status: "ready", account_name: "微信账号" })); await wait(); await wait(); await wait(); });
    const apply = requests.find((request) => request.path.endsWith("/weixin-pairing-001/apply"));
    assert.ok(apply, "扫码确认后应由平台自动完成接入");
    assert.deepEqual(JSON.parse(String(apply?.init?.body)), {});
    assert.doesNotMatch(document.body.textContent ?? "", /WEIXIN_TOKEN|never-return-weixin-token/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch; restore();
  }
});

test("企业微信应用向导会阻止未就绪部署，并在就绪后一次保存凭据和测试连接", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let publicCallbackReady = false;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); requests.push({ path, init });
    if (path === "/api/messaging/platforms") {
      const payload = hermesCatalog(false);
      payload.platforms.push({
        id: "wecom_callback", name: "WeCom Callback", description: "Enterprise WeChat application", docsUrl: "https://example.test/wecom",
        enabled: false, configured: false, gatewayRunning: true, state: "not_configured", errorCode: null,
        errorMessage: null, updatedAt: null, onboarding: null,
        envVars: [
          { key: "WECOM_CALLBACK_CORP_ID", required: true, isSet: false, description: "", prompt: "", help: "", url: null, isPassword: false, advanced: false },
          { key: "WECOM_CALLBACK_CORP_SECRET", required: true, isSet: false, description: "", prompt: "", help: "", url: null, isPassword: true, advanced: false },
          { key: "WECOM_CALLBACK_AGENT_ID", required: true, isSet: false, description: "", prompt: "", help: "", url: null, isPassword: false, advanced: false },
          { key: "WECOM_CALLBACK_TOKEN", required: true, isSet: false, description: "", prompt: "", help: "", url: null, isPassword: true, advanced: false },
          { key: "WECOM_CALLBACK_ENCODING_AES_KEY", required: true, isSet: false, description: "", prompt: "", help: "", url: null, isPassword: true, advanced: false },
        ],
      });
      return Promise.resolve(json(payload));
    }
    if (path === "/api/messaging/hermes/health") return Promise.resolve(json({ status: "running", sidecar: { ok: true }, bridge: { ok: true }, inboxOutbox: { inboxPending: 0, outboxPending: 0, unknownDeliveries: 0 } }));
    if (path === "/api/messaging/wecom/setup-readiness") return Promise.resolve(json(publicCallbackReady
      ? { callbackUrl: "https://readywork.example.com/wecom/callback", ready: true, reason: null }
      : { callbackUrl: null, ready: false, reason: "尚未配置企业微信公网 HTTPS 回调地址" }));
    if (path === "/api/messaging/platforms/wecom_callback" && init?.method === "PUT") return Promise.resolve(json({ ok: true, platform: "wecom_callback" }));
    if (path === "/api/messaging/platforms/wecom_callback/test" && init?.method === "POST") return Promise.resolve(json({ ok: true, state: "connected", message: "渠道连接测试成功" }));
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react"); const { act } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { HermesPlatformsPanel } = await import("../features/procurement/hermes-platforms-panel.js");
    await act(async () => { root = createRoot(host); root.render(<HermesPlatformsPanel />); await wait(); await wait(); });

    await act(async () => { document.querySelector<HTMLButtonElement>("button[aria-label='配置企业微信应用']")!.click(); await wait(); await wait(); });
    assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /企业微信应用接入/);
    assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /公网 HTTPS 回调地址/);
    assert.equal(document.querySelector<HTMLButtonElement>("button[aria-label='保存并测试企业微信应用']")?.disabled, true);
    assert.equal(requests.some((request) => request.path === "/api/messaging/platforms/wecom_callback" && request.init?.method === "PUT"), false);

    await act(async () => { [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "取消")!.click(); await wait(); });
    publicCallbackReady = true;
    await act(async () => { document.querySelector<HTMLButtonElement>("button[aria-label='配置企业微信应用']")!.click(); await wait(); await wait(); });

    const token = document.querySelector<HTMLInputElement>("input[aria-label='企业微信应用：回调 Token']")!;
    const aesKey = document.querySelector<HTMLInputElement>("input[aria-label='企业微信应用：AESKey']")!;
    assert.match(token.value, /^[A-Za-z0-9_-]{16,}$/u);
    assert.match(aesKey.value, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(token.readOnly, true);
    assert.equal(aesKey.readOnly, true);
    await act(async () => {
      setInput(document.querySelector<HTMLInputElement>("input[aria-label='企业微信应用：企业 ID']")!, "ww-readywork");
      setInput(document.querySelector<HTMLInputElement>("input[aria-label='企业微信应用：应用 Secret']")!, "corp-secret");
      setInput(document.querySelector<HTMLInputElement>("input[aria-label='企业微信应用：AgentId']")!, "1000001");
      await wait();
    });
    await act(async () => { document.querySelector<HTMLButtonElement>("button[aria-label='保存并测试企业微信应用']")!.click(); await wait(); await wait(); await wait(); });

    const put = requests.find((request) => request.path === "/api/messaging/platforms/wecom_callback" && request.init?.method === "PUT");
    assert.ok(put, "向导应一次性保存企业微信应用凭据");
    assert.deepEqual(JSON.parse(String(put.init?.body)), {
      enabled: true,
      env: {
        WECOM_CALLBACK_CORP_ID: "ww-readywork",
        WECOM_CALLBACK_CORP_SECRET: "corp-secret",
        WECOM_CALLBACK_AGENT_ID: "1000001",
        WECOM_CALLBACK_TOKEN: token.value,
        WECOM_CALLBACK_ENCODING_AES_KEY: aesKey.value,
      },
      clearEnv: [],
    });
    assert.match(new Headers(put.init?.headers).get("Idempotency-Key") ?? "", /^hermes-platform:configure:wecom_callback:/u);
    assert.ok(requests.some((request) => request.path === "/api/messaging/platforms/wecom_callback/test" && request.init?.method === "POST"), "保存后必须调用真实连接测试");
    assert.doesNotMatch(document.body.textContent ?? "", new RegExp(`${token.value}|${aesKey.value}|corp-secret`, "u"));
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch; restore();
  }
});

test('M3 unknown channels, providers and adapters remain distinguishable without exposing raw identifiers',async()=>{
  const {host,restore}=installDom();const previousFetch=globalThis.fetch;let root:any;let runAct:any;
  const base=gateway('degraded');
  const rows=[{id:'unknown-a',channel:'future-a',provider:'password=PROVIDER_A'},{id:'unknown-b',channel:'future-b',provider:'password=PROVIDER_B'},{id:'unknown-c',channel:'future-a',provider:'password=PROVIDER_A'}];
  globalThis.fetch=(async()=>json({...base,adapters:rows.map(row=>({...base.adapters[0],...row}))})) as typeof fetch;
  (globalThis as Record<string,unknown>).IS_REACT_ACT_ENVIRONMENT=true;
  try {
    const React=await import('react');runAct=React.act;const {createRoot}=await import('react-dom/client');
    const {MessagingGatewayPanel}=await import('../features/procurement/messaging-gateway-panel.js');
    await React.act(async()=>{root=createRoot(host);root.render(<MessagingGatewayPanel/>);await wait();await wait();});
    const articles=[...document.querySelectorAll('article')];
    assert.equal(new Set(articles.map(row=>row.querySelector('h3')?.textContent)).size,3);
    assert.notEqual(articles[0]?.querySelector('p')?.textContent,articles[1]?.querySelector('p')?.textContent);
    assert.doesNotMatch(document.body.textContent??'',/PROVIDER_A|PROVIDER_B|password=|future-a|unknown-a/);
  } finally {if(runAct) await runAct(async()=>root?.unmount());globalThis.fetch=previousFetch;restore();}
});

function gateway(status: string, version = 7, manage = true) {
  return {
    status: status === "running" ? "running" : "blocked",
    checkedAt: "2026-09-08T08:00:00.000Z",
    permissions: { manage },
    adapters: [{
      id: "email", channel: "email", provider: "smtp", status, capabilities: ["send", "receive"], version,
      consecutiveFailures: status === "degraded" ? 3 : 0, lastHealthAt: "2026-09-08T08:00:00.000Z",
      lastError: status === "degraded" ? "SMTP 连接超时" : null,
      pauseReason: status === "paused" ? "服务商维护" : null,
      pendingInbound: 2, pendingDeliveries: 1, exceptionalDeliveries: 4,
    }],
  };
}

test("消息网关面板以真实摘要呈现加载、空态、错误及全部适配器状态", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  let response: Response | Promise<Response> = new Promise(() => undefined);
  globalThis.fetch = (() => Promise.resolve(response).then((result) => result.clone())) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react"); const { act } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { MessagingGatewayPanel } = await import("../features/procurement/messaging-gateway-panel.js");
    await act(async () => { root = createRoot(host); root.render(<MessagingGatewayPanel />); await wait(); });
    assert.match(document.body.textContent ?? "", /正在读取消息网关状态/);

    response = json({ status: "running", checkedAt: "2026-09-08T08:00:00.000Z", permissions: { manage: false }, adapters: [] });
    await act(async () => { root!.render(<MessagingGatewayPanel key="empty" />); await wait(); await wait(); });
    assert.match(document.body.textContent ?? "", /暂无已注册的消息适配器/);

    response = json({ error: "网关暂时不可用" }, 503);
    await act(async () => { root!.render(<MessagingGatewayPanel key="error" />); await wait(); await wait(); });
    assert.match(document.body.textContent ?? "", /网关暂时不可用/);

    for (const [index, status, label] of [[0, "running", "运行中"], [1, "degraded", "性能下降"], [2, "paused", "已暂停"], [3, "paused_by_breaker", "已熔断"], [4, "disabled", "已禁用"], [5, "unconfigured", "未配置"]] as const) {
      response = json(gateway(status));
      await act(async () => { root!.render(<MessagingGatewayPanel key={String(index)} />); await wait(); await wait(); });
      assert.match(document.body.textContent ?? "", new RegExp(label));
      if (status === "running") {
        assert.match(document.body.textContent ?? "", /邮件适配器/);
        assert.doesNotMatch(document.body.textContent ?? "", /\bemail\b|\bsmtp\b/);
        assert.equal(document.querySelector<HTMLButtonElement>("button[aria-label='暂停邮件适配器']")?.textContent?.trim(), "暂停");
      }
    }
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch; restore();
  }
});

test("消息网关管理员暂停恢复携带版本、锁定对话框、冲突后重新读取并在成功后刷新", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  let resolvePause: ((value: Response) => void) | undefined;
  let reads = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = String(input); requests.push({ path, init });
    if (path === "/api/messaging/gateway") {
      reads += 1;
      if (reads === 1) return Promise.resolve(json(gateway("running", 7)));
      if (reads === 2) return Promise.resolve(json(gateway("paused", 8)));
      if (reads === 3) return Promise.resolve(json({ error: "网关暂时不可用" }, 503));
      return Promise.resolve(json(gateway("paused", 9)));
    }
    if (path === "/api/messaging/adapters/email/pause") return new Promise<Response>((resolve) => { resolvePause = resolve; });
    if (path === "/api/messaging/adapters/email/resume") return Promise.resolve(json({ error: "版本已变化" }, 409));
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react"); const { act } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { MessagingGatewayPanel } = await import("../features/procurement/messaging-gateway-panel.js");
    await act(async () => { root = createRoot(host); root.render(<MessagingGatewayPanel />); await wait(); await wait(); });
    const pause = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "暂停")!;
    await act(async () => { pause.click(); await wait(); });
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    const confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("确认暂停"))!;
    assert.equal(confirm.disabled, true, "空原因不得提交暂停");
    const reason = dialog.querySelector<HTMLTextAreaElement>("textarea[aria-label=操作原因]")!;
    await act(async () => {
      setTextarea(reason, "计划维护"); await wait();
      const submit = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("确认暂停"))!;
      submit.click(); submit.click();
      await wait();
    });
    await act(async () => { document.querySelector<HTMLButtonElement>("[aria-label=关闭消息网关操作]")?.click(); await wait(); });
    assert.ok(document.querySelector("[role=dialog]"), "请求中不得关闭对话框");
    assert.equal(pause.disabled, true, "请求中不得重复操作");
    const pauseRequest = requests.find((request) => request.path.endsWith("/pause"))!;
    assert.equal(requests.filter((request) => request.path.endsWith("/pause")).length, 1, "同一 tick 的重复确认只能发出一次暂停请求");
    assert.deepEqual(JSON.parse(String(pauseRequest.init?.body)), { expectedVersion: 7, reason: "计划维护" });
    assert.match(new Headers(pauseRequest.init?.headers).get("Idempotency-Key") ?? "", /^messaging-gateway:pause:email:v7:/);
    await act(async () => { resolvePause!(json({ adapter: gateway("paused", 8).adapters[0] })); await wait(); await wait(); });
    assert.equal(reads, 2, "成功操作后必须重新读取权威状态");
    assert.match(document.body.textContent ?? "", /已暂停/);

    const resume = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "恢复")!;
    await act(async () => { resume.click(); await wait(); });
    const resumeDialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    const resumeReason = resumeDialog.querySelector<HTMLTextAreaElement>("textarea[aria-label=操作原因]")!;
    await act(async () => { setTextarea(resumeReason, "维护完成"); await wait(); [...resumeDialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("确认恢复"))!.click(); await wait(); await wait(); });
    const resumeRequest = requests.find((request) => request.path.endsWith("/resume"))!;
    assert.deepEqual(JSON.parse(String(resumeRequest.init?.body)), { expectedVersion: 8, reason: "维护完成" });
    assert.match(document.body.textContent ?? "", /版本已变化/);
    const conflictDialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    assert.equal([...conflictDialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("确认恢复"))?.disabled, true, "409 后旧版本确认不得再次提交");
    const dialogReread = [...conflictDialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "重新读取")!;
    await act(async () => { dialogReread.click(); await wait(); await wait(); });
    const failedRereadDialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    assert.ok(failedRereadDialog, "冲突后重读失败不得关闭对话框");
    assert.equal(failedRereadDialog.querySelector<HTMLTextAreaElement>("textarea[aria-label=操作原因]")?.value, "维护完成", "冲突后重读失败不得丢失原原因");
    assert.equal([...failedRereadDialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("确认恢复"))?.disabled, true, "重读失败后旧版本确认仍须禁用");
    const retryReread = [...failedRereadDialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "重新读取")!;
    await act(async () => { retryReread.click(); await wait(); await wait(); });
    assert.equal(reads, 4, "冲突后只允许通过对话框重复读取权威状态");
    assert.equal(document.querySelector("[role=dialog]"), null, "成功读取权威状态后才关闭冲突对话框");
    assert.match(document.body.textContent ?? "", /版本 9/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch; restore();
  }
});

test("消息网关保留成功快照时禁用动作，并隐藏运行详情中的地址和凭据", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let root: { render: (node: React.ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  const snapshot = gateway("degraded", 7, false);
  snapshot.adapters[0]!.lastError = "供应商 supplier@example.test password=topsecret 连接超时";
  let reads = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    if (String(input) !== "/api/messaging/gateway") throw new Error(`unexpected fetch: ${String(input)}`);
    reads += 1;
    return Promise.resolve(reads === 1 ? json(snapshot) : json({ error: "网关刷新失败" }, 503));
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react"); const { act } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { MessagingGatewayPanel } = await import("../features/procurement/messaging-gateway-panel.js");
    await act(async () => { root = createRoot(host); root.render(<MessagingGatewayPanel />); await wait(); await wait(); });
    assert.match(document.body.textContent ?? "", /性能下降/);
    assert.doesNotMatch(document.body.textContent ?? "", /supplier@example\.test|topsecret/);
    const pause = document.querySelector<HTMLButtonElement>("button[aria-label='暂停邮件适配器']")!;
    assert.equal(pause.disabled, true, "非管理员只能读取，不可暂停");
    await act(async () => { document.querySelector<HTMLButtonElement>("button[aria-label='重新读取消息网关状态']")!.click(); await wait(); await wait(); });
    assert.match(document.body.textContent ?? "", /性能下降/);
    assert.match(document.body.textContent ?? "", /网关刷新失败/);
    assert.equal(pause.disabled, true, "读取失败保留快照时仍不可操作");
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch; restore();
  }
});
