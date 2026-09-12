import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RiskSparkline } from "../features/procurement/risk-recharts";

test("Risk sparkline renders without zero-size chart warnings during first layout", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://readywork.test/" });
  const previous = new Map<string, unknown>();
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, (globalThis as Record<string, unknown>)[key]);
    (globalThis as Record<string, unknown>)[key] = value;
  }
  const warnings: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...values: unknown[]) => { warnings.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { warnings.push(values.map(String).join(" ")); };
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    root = createRoot(dom.window.document.querySelector<HTMLDivElement>("#root")!);
    await act(async () => {
      root!.render(<RiskSparkline values={[18, 24, 21, 31]} />);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.ok(dom.window.document.querySelector('[aria-label="高风险 PO 占比趋势"]'));
    assert.doesNotMatch(warnings.join("\n"), /width\(0\)[\s\S]*height\(0\)|chart should be greater than 0/i);
  } finally {
    if (root) await act(async () => root!.unmount());
    console.warn = originalWarn;
    console.error = originalError;
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  }
});
