import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://readywork.test/product" });
  let uuidCall = 0;
  Object.defineProperty(dom.window.crypto, "randomUUID", {
    configurable: true,
    value: () => `00000000-0000-4000-8000-${String(++uuidCall).padStart(12, "0")}`,
  });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
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

function setValue(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
}

function fillRequiredFields(form: HTMLFormElement): void {
  setValue(form.elements.namedItem("fullName") as HTMLInputElement, "张伟");
  setValue(form.elements.namedItem("email") as HTMLInputElement, "buyer@example.com");
  setValue(form.elements.namedItem("company") as HTMLInputElement, "示例采购公司");
}

test("demo request form synchronously blocks duplicate submits while the first write is pending", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  const pending = deferred<Response>();
  const requests: Array<{ body: Record<string, unknown>; key: string | null }> = [];
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("idempotency-key") });
    return pending.promise;
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react");
    runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { DemoRequestForm } = await import("../app/product/demo-request-form.js");
    await act(async () => {
      const rendered = createRoot(host);
      root = rendered;
      rendered.render(<DemoRequestForm />);
    });
    const form = host.querySelector<HTMLFormElement>("form")!;
    fillRequiredFields(form);
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    assert.equal(requests.length, 1, "a same-tick duplicate must not create a second write");
    assert.equal(requests[0]?.key, "readywork-demo:00000000-0000-4000-8000-000000000001");
    assert.equal(requests[0]?.body.fullName, "张伟");
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    assert.equal(submit.disabled, true);
    assert.match(submit.textContent ?? "", /正在保存申请/);
    pending.resolve(response({ accepted: true, requestId: "demo:one", submittedAt: "2026-09-06T08:00:00.000Z", replayed: false }, 201));
    await act(async () => { await pending.promise; await Promise.resolve(); });
    assert.match(host.textContent ?? "", /您的申请已保存/);
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("demo request failure keeps the form and idempotency key; success resets both", async () => {
  const { host, restore } = installDom();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ body: Record<string, unknown>; key: string | null }> = [];
  let attempt = 0;
  let root: { unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push({ body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("idempotency-key") });
    attempt += 1;
    if (attempt === 1) return response({ error: "演示申请服务暂时不可用" }, 503);
    return response({ accepted: true, requestId: `demo:${attempt}`, submittedAt: "2026-09-06T08:00:00.000Z", replayed: false }, 201);
  }) as typeof fetch;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const { act } = await import("react");
    runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { DemoRequestForm } = await import("../app/product/demo-request-form.js");
    await act(async () => {
      const rendered = createRoot(host);
      root = rendered;
      rendered.render(<DemoRequestForm />);
    });
    const form = host.querySelector<HTMLFormElement>("form")!;
    fillRequiredFields(form);
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.match(host.querySelector('[role="alert"]')?.textContent ?? "", /演示申请服务暂时不可用/);
    assert.equal((form.elements.namedItem("fullName") as HTMLInputElement).value, "张伟");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.key, requests[0]?.key, "retrying an uncertain write must reuse its idempotency key");
    assert.match(host.textContent ?? "", /您的申请已保存/);
    const another = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("再提交"))!;
    await act(async () => another.click());
    const secondForm = host.querySelector<HTMLFormElement>("form")!;
    fillRequiredFields(secondForm);
    await act(async () => {
      secondForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.equal(requests.length, 3);
    assert.notEqual(requests[2]?.key, requests[1]?.key, "a new accepted request must get a new idempotency key");
  } finally {
    if (runAct) await runAct(async () => root?.unmount());
    globalThis.fetch = originalFetch;
    restore();
  }
});
