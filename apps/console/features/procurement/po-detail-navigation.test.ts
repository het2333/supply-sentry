import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LEGACY_PO_DETAIL_TAB_REDIRECTS,
  PO_DETAIL_TABS,
  poDetailNavigationForPurchaseOrderSelection,
  poDetailTabForKeyboardNavigation,
  poDetailTabFromNavigationValue,
} from "./po-detail-navigation";

describe("PO detail navigation contract", () => {
  it("keeps the six canonical tabs in their product-defined order and semantics", () => {
    assert.deepEqual(
      PO_DETAIL_TABS.map((tab) => ({ id: tab.id, canonicalLabel: tab.canonicalLabel })),
      [
        { id: "overview", canonicalLabel: "Overview" },
        { id: "items", canonicalLabel: "Items" },
        { id: "supplier", canonicalLabel: "Supplier" },
        { id: "documents", canonicalLabel: "Documents" },
        { id: "history", canonicalLabel: "History" },
        { id: "communication", canonicalLabel: "Communication" },
      ],
    );
  });

  it("accepts every canonical tab without changing its identity", () => {
    for (const tab of PO_DETAIL_TABS) {
      assert.equal(poDetailTabFromNavigationValue(tab.id), tab.id);
    }
  });

  it("routes retired PO detail tabs to their canonical semantic owner", () => {
    assert.deepEqual(LEGACY_PO_DETAIL_TAB_REDIRECTS, {
      analysis: "overview",
      timeline: "history",
      messages: "communication",
      documents: "documents",
      audit: "history",
      context: "overview",
    });
    for (const [legacyTab, canonicalTab] of Object.entries(LEGACY_PO_DETAIL_TAB_REDIRECTS)) {
      assert.equal(poDetailTabFromNavigationValue(legacyTab), canonicalTab);
    }
  });

  it("rejects malformed and unknown PO detail navigation state", () => {
    assert.equal(poDetailTabFromNavigationValue("attachments"), null);
    assert.equal(poDetailTabFromNavigationValue(null), null);
    assert.equal(poDetailTabFromNavigationValue({ tab: "overview" }), null);
  });

  it("switches from PO A on a nested tab to PO B Overview as one target", () => {
    const current = { purchaseOrderId: "po:A", tab: "documents" as const };
    const next = poDetailNavigationForPurchaseOrderSelection("po:B");

    assert.deepEqual(current, { purchaseOrderId: "po:A", tab: "documents" });
    assert.deepEqual(next, { purchaseOrderId: "po:B", tab: "overview" });
    assert.throws(() => poDetailNavigationForPurchaseOrderSelection("   "), /requires an ID/);
  });

  it("supports the complete horizontal roving-tab keyboard contract", () => {
    assert.equal(poDetailTabForKeyboardNavigation("overview", "ArrowRight"), "items");
    assert.equal(poDetailTabForKeyboardNavigation("overview", "ArrowLeft"), "communication");
    assert.equal(poDetailTabForKeyboardNavigation("communication", "ArrowRight"), "overview");
    assert.equal(poDetailTabForKeyboardNavigation("documents", "Home"), "overview");
    assert.equal(poDetailTabForKeyboardNavigation("items", "End"), "communication");
  });
});
