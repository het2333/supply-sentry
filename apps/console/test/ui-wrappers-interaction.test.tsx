import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import type { ReactNode } from "react";

function installDom(): { host: HTMLDivElement; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://readywork.test/" });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent,
    CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver, Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter, DOMRect: dom.window.DOMRect, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id), ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) { previous.set(key, (globalThis as Record<string, unknown>)[key]); (globalThis as Record<string, unknown>)[key] = value; }
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  return { host: dom.window.document.querySelector<HTMLDivElement>("#root")!, restore: () => {
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  } };
}

function changeInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView!.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("rendered wrappers preserve table states, command selection, complete dates, and sanitized HTML", async () => {
  const { host, restore } = installDom();
  let root: { render: (node: ReactNode) => void; unmount: () => void } | undefined;
  let runAct: ((callback: () => void | Promise<void>) => Promise<void>) | undefined;
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    const React = await import("react");
    const { act, useState } = React; runAct = act;
    const { createRoot } = await import("react-dom/client");
    const { DataTable } = await import("../components/ui/data-table.js");
    const { CommandMenu } = await import("../components/ui/command-menu.js");
    const { DateRangePicker } = await import("../components/ui/date-range.js");
    const { SafeHtml } = await import("../components/ui/safe-html.js");
    const columns = [{ accessorKey: "name", header: "Name" }];
    const rows = [{ name: "Alpha" }, { name: "Beta" }];

    function Harness() {
      const [selected, setSelected] = useState("none");
      const [range, setRange] = useState({ from: "2026-09-10", to: "2026-09-12" });
      return <>
        <CommandMenu ariaLabel="Objects" items={[{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }]} onSelect={setSelected} />
        <output aria-label="selected command">{selected}</output>
        <DateRangePicker ariaLabel="Delivery range" value={range} onChange={setRange} />
        <output aria-label="selected range">{range.from}/{range.to}</output>
        <SafeHtml html={'<p id="safe">Approved <img src="x" onerror="window.pwned=true"></p><script>window.pwned=true</script>'} />
      </>;
    }

    await act(async () => { const rendered = createRoot(host); root = rendered; rendered.render(<Harness />); });
    const commandInput = document.querySelector<HTMLInputElement>('[aria-label="Objects search"]')!;
    await act(async () => { changeInput(commandInput, "Beta"); });
    const filteredItems = [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];
    assert.equal(filteredItems.some((item) => item.textContent === "Alpha"), false);
    assert.equal(filteredItems.some((item) => item.textContent === "Beta"), true);
    await act(async () => {
      commandInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      commandInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.equal(document.querySelector('[aria-label="selected command"]')?.textContent, "beta");

    const dayButton = (day: string) => document.querySelector<HTMLButtonElement>(`button[data-day="${day}"], [data-day="${day}"] button`)!;
    assert.ok(dayButton("2026-09-15"));
    await act(async () => { dayButton("2026-09-15").click(); });
    await act(async () => { dayButton("2026-09-18").click(); });
    assert.equal(document.querySelector('[aria-label="selected range"]')?.textContent, "2026-09-10/2026-09-18");
    assert.equal(document.querySelector("script"), null);
    assert.equal(document.querySelector("#safe img")?.hasAttribute("onerror"), false);

    await act(async () => { root!.render(<DataTable ariaLabel="Records" columns={columns} rows={[]} loading />); });
    assert.equal(document.querySelector('[role="status"]')?.textContent, "Loading…");
    await act(async () => { root!.render(<DataTable ariaLabel="Records" columns={columns} rows={[]} error="Read failed" />); });
    assert.equal(document.querySelector('[role="alert"]')?.textContent, "Read failed");
    await act(async () => { root!.render(<DataTable ariaLabel="Records" columns={columns} rows={[]} empty="Nothing here" />); });
    assert.match(document.querySelector("table")?.textContent ?? "", /Nothing here/);
    await act(async () => { root!.render(<DataTable ariaLabel="Records" columns={columns} rows={rows} />); });
    assert.deepEqual([...document.querySelectorAll("tbody tr")].map((row) => row.textContent), ["Alpha", "Beta"]);
    await act(async () => { root!.render(<DataTable ariaLabel="Virtual records" columns={columns} rows={Array.from({ length: 100 }, (_, index) => ({ name: `Row ${index + 1}` }))} virtualize />); });
    assert.equal(document.querySelector("table")?.getAttribute("aria-rowcount"), "100");
    assert.ok(document.querySelectorAll("tbody tr").length < 100);
  } finally {
    if (runAct) await runAct(async () => { root?.unmount(); });
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = false;
    restore();
  }
});
