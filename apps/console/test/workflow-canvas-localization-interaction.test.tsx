import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("workflow canvas renders Chinese controls, accessibility copy, and port counts", async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://readywork.test/" });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent, Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, (globalThis as Record<string, unknown>)[key]]));
  Object.assign(globalThis, globals);
  Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: globals.requestAnimationFrame });
  Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: globals.cancelAnimationFrame });

  const { act, createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { WorkflowCanvas } = await import("../features/editor/workflow-canvas.js");
  const root = createRoot(document.querySelector("#root")!);
  try {
    await act(async () => {
      root.render(createElement(WorkflowCanvas, {
        workflowId: "workflow:localization",
        revision: 1,
        nodes: [{ id: "node:one", kind: "logic", label: "示例节点", detail: "用于验证画布本地化", inputs: ["input"], outputs: ["output"], position: { x: 72, y: 72 } }],
        edges: [], selectedNodeId: null, selectedEdgeId: null, saving: false, loading: false, runtimeOverlay: null,
        onSelectNode: () => undefined, onSelectEdge: () => undefined, onAddAsset: async () => undefined, onCommit: async () => true,
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const markup = document.body.innerHTML;

    for (const expected of [
      'aria-label="画布控制面板"', 'aria-label="放大画布"', 'aria-label="缩小画布"',
      'aria-label="适配全部节点"', "画布缩略图", "1 个输入", "1 个输出",
    ]) assert.match(markup, new RegExp(expected));

    assert.doesNotMatch(markup, /Control Panel|Zoom In|Zoom Out|Fit View|Mini Map|>1 in<|>1 out</);
  } finally {
    await act(async () => root.unmount());
    for (const [key, value] of previous) (globalThis as Record<string, unknown>)[key] = value;
    dom.window.close();
  }
});
