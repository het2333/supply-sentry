import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { UI_LANGUAGE_STORAGE_KEY, resolveUiLanguage } from "../features/localization/ui-language-preference";

test("language links override only valid local preferences, never tenant settings", () => {
  assert.equal(resolveUiLanguage("?section=orders&lang=en", "zh-CN"), "en");
  assert.equal(resolveUiLanguage("?lang=invalid", "en"), "en");
  assert.equal(resolveUiLanguage("", null), "zh-CN");
  assert.equal(resolveUiLanguage("?lang=zh-CN", "en"), "zh-CN");
});

test("native dialogs localize their prompt but preserve the user's retained response", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const dom = new JSDOM('<html lang="en"></html>');
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  try {
    const { uiConfirm, uiPrompt } = await import("../features/localization/ui-dialogs");
    let prompt: string | undefined;
    let retained: string | undefined;
    window.confirm = (message) => { prompt = message; return false; };
    window.prompt = (message, value) => { prompt = message; retained = value; return value ?? null; };
    assert.equal(uiConfirm("保存更改"), false);
    assert.equal(prompt, "Save changes");
    assert.equal(uiPrompt("备注", "设置"), "设置");
    assert.equal(prompt, "Notes");
    assert.equal(retained, "设置");
  } finally { globalThis.window = previousWindow; globalThis.document = previousDocument; dom.window.close(); }
});

test("visible switch persists across a fresh mount and keeps navigation and draft state", async () => {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: "http://readywork.test/?section=orders&poId=po%3A123&poTab=history&lang=en#evidence" });
  const previous = new Map<string, unknown>();
  for (const name of ["window", "document", "Element", "HTMLElement", "Node", "NodeFilter", "MutationObserver", "Event", "MouseEvent"] as const) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    (globalThis as Record<string, unknown>)[name] = dom.window[name];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { UiLanguageProvider, LanguageSwitcher } = await import("../features/localization/ui-language");
  const host = document.querySelector<HTMLDivElement>("#root")!;
  let root = createRoot(host);
  const render = () => <UiLanguageProvider><LanguageSwitcher /><h1>总览</h1><input id="unsaved" defaultValue="draft" /></UiLanguageProvider>;
  try {
    await act(async () => root.render(render()));
    assert.equal(document.querySelector("h1")!.textContent, "Overview");
    assert.equal(document.documentElement.lang, "en");
    assert.equal(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY), "en");
    const input = document.querySelector<HTMLInputElement>("#unsaved")!;
    input.value = "供应商回复草稿";
    await act(async () => document.querySelector<HTMLButtonElement>('[lang="zh-CN"]')!.click());
    assert.equal(document.querySelector("h1")!.textContent, "总览");
    assert.equal(window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY), "zh-CN");
    assert.equal(new URL(window.location.href).searchParams.get("poId"), "po:123");
    assert.equal(new URL(window.location.href).searchParams.get("poTab"), "history");
    assert.equal(window.location.hash, "#evidence");
    assert.equal(document.querySelector<HTMLInputElement>("#unsaved")!.value, "供应商回复草稿");
    await act(async () => document.querySelector<HTMLButtonElement>('[lang="en"]')!.click());
    await act(async () => root.unmount());
    window.history.replaceState({}, "", "/?section=settings");
    root = createRoot(host);
    await act(async () => root.render(render()));
    assert.equal(document.querySelector("h1")!.textContent, "Overview");
    assert.equal(document.querySelector('button[lang="en"]')!.getAttribute("aria-pressed"), "true");
    // Cross-tab preference changes and back/forward language links are honored.
    await act(async () => { window.history.replaceState({}, "", "/?lang=zh-CN"); window.dispatchEvent(new dom.window.PopStateEvent("popstate")); });
    assert.equal(document.querySelector("h1")!.textContent, "总览");
  } finally {
    await act(async () => root.unmount());
    for (const [name, value] of previous) (globalThis as Record<string, unknown>)[name] = value;
    dom.window.close();
  }
});
