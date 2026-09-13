import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://readywork.test/" });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
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

test("translates known schedule, currency, and supplier-confirmation UI labels", async () => {
  const { translateReadyworkUiText } = await import("../features/localization/chinese-ui-localization.js");
  assert.equal(translateReadyworkUiText("On schedule"), "按计划推进");
  assert.equal(translateReadyworkUiText("Priced in CNY"), "以 CNY 计价");
  assert.equal(translateReadyworkUiText("Priced in EUR"), "以 EUR 计价");
  assert.equal(translateReadyworkUiText("Awaiting Confirmation"), "等待确认");
});

test("procurement Import means overseas sourcing rather than importing data", async () => {
  const { translateReadyworkUiText } = await import("../features/localization/chinese-ui-localization.js");
  assert.equal(translateReadyworkUiText("Import"), "进口采购");
  assert.equal(translateReadyworkUiText("Import Procurement"), "进口采购");
  assert.equal(translateReadyworkUiText("Ask anything about import POs…"), "询问有关进口采购订单的任何问题…");
});

test("English interface text translates labels without rewriting unknown business content", async () => {
  const { translateReadyworkUiText } = await import("../features/localization/chinese-ui-localization.js");
  assert.equal(translateReadyworkUiText("进口采购", "en"), "Import Procurement");
  assert.equal(translateReadyworkUiText("保存更改", "en"), "Save changes");
  assert.equal(translateReadyworkUiText("上海供应商说大概两周", "en"), "上海供应商说大概两周");
  assert.equal(translateReadyworkUiText("constructor", "en"), "constructor");
  assert.equal(translateReadyworkUiText("__proto__", "zh-CN"), "__proto__");
  assert.equal(translateReadyworkUiText("显示第 1 至 10 项，共 25 项", "en"), "Showing 1 to 10 of 25 entries");
  assert.equal(translateReadyworkUiText("编辑供应商 设置", "en"), "Edit supplier 设置");
  assert.equal(translateReadyworkUiText(" · 返回总览", "en"), " · Back to Overview");
  assert.equal(translateReadyworkUiText("返回本地采购", "en"), "Back to Local Procurement");
});

test("switching language preserves inputs, source evidence, handlers and later React updates", async () => {
  const installed = installDom();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const { act, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChineseUiLocalization } = await import("../features/localization/chinese-ui-localization.js");
  function Probe({ language }: { language: "en" | "zh-CN" }) {
    const [updated, setUpdated] = useState(false);
    return <><ChineseUiLocalization language={language} />
      <button id="action" onClick={() => setUpdated(!updated)} title={updated ? "设置" : "报表"}>{updated ? "通知" : "总览"}</button>
      <input id="draft" defaultValue="供应商原话：设置" placeholder={updated ? "搜索供应商…" : "搜索采购订单…"} />
      <textarea placeholder="搜索采购订单…" defaultValue="设置" />
      <p data-preserve-language>设置</p><div contentEditable suppressContentEditableWarning>供应商</div>
      {updated && <aside role="dialog">保存更改</aside>}
    </>;
  }
  const root = createRoot(installed.host);
  try {
    await act(async () => { root.render(<Probe language="en" />); });
    const button = document.querySelector<HTMLButtonElement>("#action")!;
    const input = document.querySelector<HTMLInputElement>("#draft")!;
    assert.equal(button.textContent, "Overview");
    assert.equal(button.title, "Reports");
    assert.equal(input.placeholder, "Search purchase orders…");
    assert.equal(document.querySelector("textarea")!.placeholder, "Search purchase orders…");
    assert.equal(document.querySelector("textarea")!.value, "设置");
    assert.equal(document.querySelector("[data-preserve-language]")!.textContent, "设置");
    assert.equal(document.querySelector("[contenteditable]")!.textContent, "供应商");
    input.value = "未保存的供应商原话";
    await act(async () => { button.click(); });
    assert.equal(button.textContent, "Notifications");
    assert.equal(document.querySelector("[role=dialog]")!.textContent, "Save changes");
    await act(async () => { root.render(<Probe language="zh-CN" />); });
    assert.equal(button.textContent, "通知");
    assert.equal(button.title, "设置");
    assert.equal(input.value, "未保存的供应商原话");
    await act(async () => { root.render(<Probe language="en" />); button.click(); });
    assert.equal(button.textContent, "Overview");
    assert.equal(button.title, "Reports");
    assert.equal(document.querySelector("[role=dialog]"), null);
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test("localizes aria-label, title, and placeholder after React updates an existing element", async () => {
  const installed = installDom();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const { act, useState } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChineseUiLocalization } = await import("../features/localization/chinese-ui-localization.js");

  function Probe() {
    const [updated, setUpdated] = useState(false);
    return <>
      <ChineseUiLocalization />
      <button type="button" onClick={() => setUpdated(true)} aria-label={updated ? "Notifications" : "Overview"} title={updated ? "Settings" : "Reports"}>update</button>
      <input placeholder={updated ? "Search suppliers…" : "Search purchase orders…"} />
    </>;
  }

  const root = createRoot(installed.host);
  try {
    await act(async () => { root.render(<Probe />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    const button = document.querySelector("button")!;
    const input = document.querySelector("input")!;
    assert.equal(button.getAttribute("aria-label"), "总览");
    assert.equal(button.title, "报表");
    assert.equal(input.placeholder, "搜索采购订单…");

    await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(button.getAttribute("aria-label"), "通知");
    assert.equal(button.title, "设置");
    assert.equal(input.placeholder, "搜索供应商…");
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});

test("preserves supplier, email, note, and filename business content inside an explicit boundary", async () => {
  const installed = installDom();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ChineseUiLocalization } = await import("../features/localization/chinese-ui-localization.js");
  const root = createRoot(installed.host);
  try {
    await act(async () => {
      root.render(<><ChineseUiLocalization /><section data-preserve-language>
        <span data-kind="supplier">Local</span>
        <span data-kind="subject">Draft</span>
        <span data-kind="body">High Risk</span>
        <span data-kind="note">On schedule</span>
        <span data-kind="filename">Overview</span>
      </section></>);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(
      [...document.querySelectorAll<HTMLElement>("[data-kind]")].map((element) => element.textContent),
      ["Local", "Draft", "High Risk", "On schedule", "Overview"],
    );
  } finally {
    await act(async () => root.unmount());
    installed.restore();
  }
});
