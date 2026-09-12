export const READYWORK_PROCUREMENT_VISUAL_TOKENS = Object.freeze({
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

export const READYWORK_PAGE_TITLE_CLASS =
  "text-[26px] font-bold tracking-[-0.025em] text-[#0f172a]";

export const READYWORK_PAGE_CONTAINER_CLASS = "w-full";

export const READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS = "xl:pr-[200px]";

export function procurementHeaderPresentation(input: {
  section: string;
  purchaseOrderId: string | null;
}): { integrated: boolean; showSearch: boolean } {
  const purchaseOrderDetail = input.section === "orders" && Boolean(input.purchaseOrderId);
  return {
    integrated: purchaseOrderDetail || ["home", "notifications", "message-drafts", "local-procurement", "import-procurement", "risk-dashboard", "suppliers", "sla", "advanced-sla", "settings"].includes(input.section),
    showSearch: !purchaseOrderDetail && !["notifications", "message-drafts", "local-procurement", "import-procurement", "risk-dashboard", "suppliers", "sla", "advanced-sla", "settings"].includes(input.section),
  };
}
