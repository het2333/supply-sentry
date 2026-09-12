/**
 * Canonical navigation contract for purchase-order detail surfaces.
 *
 * IDs are intentionally stable English values for URLs and persisted UI state;
 * labels may be localized by the rendered surface.
 */
export const PO_DETAIL_TABS = [
  { id: "overview", label: "概览", canonicalLabel: "Overview" },
  { id: "items", label: "行项目", canonicalLabel: "Items" },
  { id: "supplier", label: "供应商", canonicalLabel: "Supplier" },
  { id: "documents", label: "文档", canonicalLabel: "Documents" },
  { id: "history", label: "历史记录", canonicalLabel: "History" },
  { id: "communication", label: "沟通", canonicalLabel: "Communication" },
] as const;

export type PoDetailTabId = (typeof PO_DETAIL_TABS)[number]["id"];

export type PoDetailNavigationTarget = {
  purchaseOrderId: string;
  tab: PoDetailTabId;
};

export type PoDetailTabKeyboardKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

const PO_DETAIL_TAB_ID_SET = new Set<string>(PO_DETAIL_TABS.map((tab) => tab.id));

/**
 * Compatibility targets for detail state written by the retired PO detail UI.
 * Every source is deliberately routed to the canonical tab that owns the same
 * business concern, rather than preserving the old implementation split.
 */
export const LEGACY_PO_DETAIL_TAB_REDIRECTS: Readonly<Record<string, PoDetailTabId>> = {
  analysis: "overview",
  timeline: "history",
  messages: "communication",
  documents: "documents",
  audit: "history",
  context: "overview",
};

/** Returns a canonical PO detail tab for canonical or legacy navigation state. */
export function poDetailTabFromNavigationValue(value: unknown): PoDetailTabId | null {
  if (typeof value !== "string") return null;
  const legacyDestination = LEGACY_PO_DETAIL_TAB_REDIRECTS[value];
  if (legacyDestination) return legacyDestination;
  return PO_DETAIL_TAB_ID_SET.has(value) ? (value as PoDetailTabId) : null;
}

/**
 * Selecting another PO is one navigation transition: the new PO and Overview
 * must be published together. Keeping that pair in one value prevents a tab
 * callback from accidentally reusing the previously selected PO ID.
 */
export function poDetailNavigationForPurchaseOrderSelection(purchaseOrderId: string): PoDetailNavigationTarget {
  const normalizedPurchaseOrderId = purchaseOrderId.trim();
  if (!normalizedPurchaseOrderId) throw new Error("Purchase order navigation requires an ID");
  return { purchaseOrderId: normalizedPurchaseOrderId, tab: "overview" };
}

/** Implements the WAI-ARIA horizontal tablist keyboard contract. */
export function poDetailTabForKeyboardNavigation(current: PoDetailTabId, key: PoDetailTabKeyboardKey): PoDetailTabId {
  const currentIndex = PO_DETAIL_TABS.findIndex((tab) => tab.id === current);
  if (key === "Home") return PO_DETAIL_TABS[0].id;
  if (key === "End") return PO_DETAIL_TABS.at(-1)!.id;
  const offset = key === "ArrowRight" ? 1 : -1;
  return PO_DETAIL_TABS[(currentIndex + offset + PO_DETAIL_TABS.length) % PO_DETAIL_TABS.length].id;
}
