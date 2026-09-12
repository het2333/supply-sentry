export const READYWORK_SECTION_VALUES = [
  "workbench",
  "home",
  "notifications",
  "message-drafts",
  "po-intake",
  "local-procurement",
  "import-procurement",
  "risk-dashboard",
  "sla",
  "advanced-sla",
  "my-work",
  "orders",
  "sourcing",
  "suppliers",
  "payables",
  "logistics",
  "documents",
  "ai-records",
  "settings",
  "overview",
  "org",
  "employees",
  "requisitions",
  "rfq",
  "tasks",
  "approvals",
  "context",
  "tools",
] as const;

export type ReadyworkSection = (typeof READYWORK_SECTION_VALUES)[number];
export type ReadyworkNavigationViewMode = "business" | "developer";
export type PurchaseOrderNavigationIntent = "edit-rihd" | "mark-at-risk";

const READYWORK_SECTION_SET = new Set<string>(READYWORK_SECTION_VALUES);
const PURCHASE_ORDER_NAVIGATION_INTENTS = new Set<PurchaseOrderNavigationIntent>(["edit-rihd", "mark-at-risk"]);

export function poNavigationIntentFromValue(value: unknown): PurchaseOrderNavigationIntent | null {
  return typeof value === "string" && PURCHASE_ORDER_NAVIGATION_INTENTS.has(value as PurchaseOrderNavigationIntent)
    ? value as PurchaseOrderNavigationIntent
    : null;
}

/**
 * Maps retired production surfaces to the closest honest, API-backed page.
 * `quote` used hard-coded sales-side data; the real supplier quote workflow is
 * the sourcing workbench. `evals` invented zero KPI values when evidence was
 * absent, so it returns to the evidence-backed procurement overview.
 */
const RETIRED_SECTION_REDIRECTS: Readonly<Record<string, ReadyworkSection>> = {
  quote: "sourcing",
  evals: "home",
};

export function sectionFromNavigationValue(value: unknown): ReadyworkSection | null {
  if (typeof value !== "string") return null;
  const retiredDestination = RETIRED_SECTION_REDIRECTS[value];
  if (retiredDestination) return retiredDestination;
  return READYWORK_SECTION_SET.has(value) ? (value as ReadyworkSection) : null;
}

/**
 * A shareable URL is authoritative. History state remains a compatibility
 * fallback for entries created before ordinary sections were written to the
 * query string. Unknown values fail closed to the real overview.
 */
export function resolveNavigationSection(urlValue: unknown, historyValue: unknown): ReadyworkSection {
  return sectionFromNavigationValue(urlValue)
    ?? sectionFromNavigationValue(historyValue)
    ?? "home";
}

export function resolveNavigationViewMode(
  section: ReadyworkSection,
  viewValue: unknown,
): ReadyworkNavigationViewMode {
  return section === "employees" && viewValue === "developer" ? "developer" : "business";
}

type NavigationScrollTarget = {
  scrollTo(options: { top: number; left: number; behavior: "auto" }): void;
};

export function resetNavigationScroll(target: NavigationScrollTarget): void {
  target.scrollTo({ top: 0, left: 0, behavior: "auto" });
}
