import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  READYWORK_SECTION_VALUES,
  poNavigationIntentFromValue,
  resolveNavigationSection,
  resolveNavigationViewMode,
  sectionFromNavigationValue,
} from "./navigation-state";
import * as navigationState from "./navigation-state";

describe("sectionFromNavigationValue", () => {
  it("accepts every production section without changing its identity", () => {
    for (const section of READYWORK_SECTION_VALUES) {
      assert.equal(sectionFromNavigationValue(section), section);
    }
  });

  it("resets document scroll before switching between workbench sections", () => {
    const resetNavigationScroll = (navigationState as unknown as {
      resetNavigationScroll?: (target: { scrollTo: (options: ScrollToOptions) => void }) => void;
    }).resetNavigationScroll;
    assert.equal(typeof resetNavigationScroll, "function", "section navigation must expose one shared scroll reset");
    const calls: ScrollToOptions[] = [];

    resetNavigationScroll!({ scrollTo: (options) => calls.push(options) });

    assert.deepEqual(calls, [{ top: 0, left: 0, behavior: "auto" }]);
  });

  it("redirects retired mock surfaces to honest API-backed pages", () => {
    assert.equal(sectionFromNavigationValue("quote"), "sourcing");
    assert.equal(sectionFromNavigationValue("evals"), "home");
    assert.equal(READYWORK_SECTION_VALUES.includes("quote" as never), false);
    assert.equal(READYWORK_SECTION_VALUES.includes("evals" as never), false);
  });

  it("rejects malformed and unknown navigation state", () => {
    assert.equal(sectionFromNavigationValue("customer-demo"), null);
    assert.equal(sectionFromNavigationValue(null), null);
    assert.equal(sectionFromNavigationValue({ section: "home" }), null);
  });

  it("restores a shareable URL before legacy history state", () => {
    assert.equal(resolveNavigationSection("local-procurement", "home"), "local-procurement");
    assert.equal(resolveNavigationSection("unknown", "suppliers"), "suppliers");
    assert.equal(resolveNavigationSection(null, null), "home");
  });

  it("keeps the explicit employee developer deep link out of ordinary business navigation", () => {
    assert.deepEqual(
      {
        section: resolveNavigationSection("employees", null),
        viewMode: resolveNavigationViewMode("employees", "developer"),
      },
      { section: "employees", viewMode: "developer" },
    );
    assert.deepEqual(
      {
        section: resolveNavigationSection("home", "employees"),
        viewMode: resolveNavigationViewMode("home", "developer"),
      },
      { section: "home", viewMode: "business" },
    );
  });

  it("accepts only the two persisted Overview row-action intents", () => {
    assert.equal(poNavigationIntentFromValue("edit-rihd"), "edit-rihd");
    assert.equal(poNavigationIntentFromValue("mark-at-risk"), "mark-at-risk");
    assert.equal(poNavigationIntentFromValue("view"), null);
    assert.equal(poNavigationIntentFromValue("send"), null);
    assert.equal(poNavigationIntentFromValue(null), null);
  });
});
