import assert from "node:assert/strict";
import test from "node:test";
import { beginManufacturingContextLoad, manufacturingContextExpandedState } from "./manufacturing-context-panel-state";

test("manufacturing context is collapsed by default again after switching purchase orders", () => {
  assert.equal(manufacturingContextExpandedState(true, "object_changed"), false);
  assert.equal(manufacturingContextExpandedState(false, "object_changed"), false);
});

test("manufacturing context disclosure toggles without changing business state", () => {
  assert.equal(manufacturingContextExpandedState(false, "toggle"), true);
  assert.equal(manufacturingContextExpandedState(true, "toggle"), false);
});

test("switching purchase orders clears the previous context before the next request resolves", () => {
  const next = beginManufacturingContextLoad({ envelope: { data: { root: { label: "PO-A" } } }, error: "old", loading: false, notice: "old notice" }, {
    objectChanged: true,
    preserveNotice: false,
  });
  assert.deepEqual(next, { envelope: null, error: null, loading: true, notice: null });
});

test("refreshing after a persisted correction keeps its success notice", () => {
  const next = beginManufacturingContextLoad({ envelope: { data: { root: { label: "PO-A" } } }, error: null, loading: false, notice: "纠正请求已保存为待审批记录；采购事实尚未改变。" }, {
    objectChanged: false,
    preserveNotice: true,
  });
  assert.equal(next.envelope?.data.root.label, "PO-A");
  assert.equal(next.notice, "纠正请求已保存为待审批记录；采购事实尚未改变。");
});
