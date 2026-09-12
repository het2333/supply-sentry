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
