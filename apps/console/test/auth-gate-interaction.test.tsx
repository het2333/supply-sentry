import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime.js";

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://readywork.test/" });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    FormData: dom.window.FormData,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = value;
  }
  return {
    host: dom.window.document.querySelector<HTMLDivElement>("#root")!,
    restore: () => {
      for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
      dom.window.close();
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const session = {
  ok: true,
  account: { username: "admin", name: "采购管理员", role: "采购经理", humanId: "human:admin" },
  expiresAt: "2026-09-06T12:00:00.000Z",
};

test("authentication gate is Chinese, toggles password visibility, and blocks same-tick duplicate login", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  const pendingLogin = deferred<Response>();
  let sessionChecks = 0;
  let loginWrites = 0;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/auth/me") {
      sessionChecks += 1;
      return sessionChecks === 1 ? response({ error: "未登录或会话过期" }, 401) : response(session);
    }
    if (path === "/api/auth/config") return response({ mode: "local_demo", passwordLogin: true });
    if (path === "/api/auth/login" && init?.method === "POST") {
      loginWrites += 1;
      assert.deepEqual(JSON.parse(String(init.body)), { username: "admin", password: "admin123" });
      return pendingLogin.promise;
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react");
    runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { AuthGate } = await import("../features/auth/auth-gate.js");
    await act(async () => {
      const rendered = createRoot(host);
      root = rendered;
      rendered.render(<PathnameContext.Provider value="/"><AuthGate><div data-testid="workspace">采购工作区</div></AuthGate></PathnameContext.Provider>);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(host.textContent ?? "", /欢迎回来/);
    assert.match(host.textContent ?? "", /登录以访问 Readywork 采购执行工作区/);
    const username = host.querySelector<HTMLInputElement>('input[name="username"]')!;
    const password = host.querySelector<HTMLInputElement>('input[name="password"]')!;
    assert.equal(password.type, "password");
    const visibility = host.querySelector<HTMLButtonElement>('button[aria-label="显示密码"]')!;
    await act(async () => visibility.click());
    assert.equal(password.type, "text");
    assert.equal(visibility.getAttribute("aria-label"), "隐藏密码");
    await act(async () => {
      setValue(username, "admin");
      setValue(password, "admin123");
    });
    const form = host.querySelector<HTMLFormElement>("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    assert.equal(loginWrites, 1, "one user action window must produce one login POST");
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    assert.equal(submit.disabled, true);
    assert.match(submit.textContent ?? "", /正在登录/);
    pendingLogin.resolve(response(session));
    await act(async () => { await pendingLogin.promise; await Promise.resolve(); await Promise.resolve(); });
    assert.equal(host.querySelector('[data-testid="workspace"]')?.textContent, "采购工作区");

    await act(async () => {
      window.dispatchEvent(new CustomEvent("readywork:auth-required", { detail: { reason: "expired" } }));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(host.textContent ?? "", /安全会话已过期/);
    assert.equal(host.querySelector<HTMLInputElement>('input[name="password"]')?.value, "");
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("public routes bypass authentication without calling the session API", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  globalThis.fetch = (async () => { fetches += 1; return response({ error: "unexpected" }, 500); }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react");
    runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { AuthGate } = await import("../features/auth/auth-gate.js");
    await act(async () => {
      const rendered = createRoot(host);
      root = rendered;
      rendered.render(<PathnameContext.Provider value="/product"><AuthGate><div data-testid="public">公开产品页</div></AuthGate></PathnameContext.Provider>);
      await Promise.resolve();
    });
    assert.equal(host.querySelector('[data-testid="public"]')?.textContent, "公开产品页");
    assert.equal(fetches, 0);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});
