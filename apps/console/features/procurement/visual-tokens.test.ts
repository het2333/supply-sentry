import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  READYWORK_PAGE_CONTAINER_CLASS,
  READYWORK_PAGE_TITLE_CLASS,
  READYWORK_PROCUREMENT_VISUAL_TOKENS,
} from "./visual-tokens";

describe("Navisight visual tokens", () => {
  it("freezes the verified application shell dimensions and colors", () => {
    assert.deepEqual(READYWORK_PROCUREMENT_VISUAL_TOKENS, {
      primary: "#2563eb",
      pageBackground: "#f8fafc",
      foreground: "#0f172a",
      sidebarExpandedPx: 248,
      sidebarCollapsedPx: 76,
      sidebarOuterPaddingPx: 12,
      sidebarPanelRadiusPx: 24,
      sidebarHeaderHeightPx: 68,
      contentPaddingPx: 28,
      pageTitlePx: 26,
      pageTitleTrackingEm: -0.025,
      sidebarTransitionMs: 320,
    });
    assert.equal(Object.isFrozen(READYWORK_PROCUREMENT_VISUAL_TOKENS), true);
  });

  it("exports one shared page title and a fluid page container", () => {
    assert.match(READYWORK_PAGE_TITLE_CLASS, /text-\[26px\]/);
    assert.match(READYWORK_PAGE_TITLE_CLASS, /tracking-\[-0\.025em\]/);
    assert.match(READYWORK_PAGE_TITLE_CLASS, /text-\[#0f172a\]/);
    assert.equal(READYWORK_PAGE_CONTAINER_CLASS, "w-full");
  });
});
