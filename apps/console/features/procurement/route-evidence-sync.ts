export type RouteEvidenceSourceItem = {
  active: boolean;
  route: string;
  routeEvidenceCandidates?: Array<{ eligible?: boolean; type?: string }>;
};

export type SupplierMasterSyncResult = {
  created: number;
  updated: number;
  unchanged: number;
  issues?: unknown[];
};

export type RouteEvidenceCoverage = {
  unclassified: number;
  eligibleErp: number;
  missingErp: number;
};

export function routeEvidenceCoverage(items: readonly RouteEvidenceSourceItem[]): RouteEvidenceCoverage {
  const unclassified = items.filter((item) => item.active && item.route === "unclassified");
  const eligibleErp = unclassified.filter((item) => item.routeEvidenceCandidates?.some(
    (candidate) => candidate.type === "erp_field" && candidate.eligible === true,
  )).length;
  return { unclassified: unclassified.length, eligibleErp, missingErp: unclassified.length - eligibleErp };
}

export function supplierRouteEvidenceSyncMessage(
  result: SupplierMasterSyncResult,
  coverage: RouteEvidenceCoverage,
): string {
  const base = `Odoo 供应商主数据同步完成：新增 ${result.created}，更新 ${result.updated}，未变化 ${result.unchanged}`;
  const issueCount = result.issues?.length ?? 0;
  const issues = issueCount > 0 ? `，另有 ${issueCount} 条坏行未写入` : "";
  if (coverage.unclassified === 0) return `${base}${issues}；当前没有路线未分类的活跃 PO。`;
  if (coverage.eligibleErp > 0) {
    return `${base}${issues}；${coverage.eligibleErp}/${coverage.unclassified} 张未分类 PO 现有可用 ERP 路线证据，请逐张由采购经理确认。`;
  }
  return `${base}${issues}；Odoo 当前仍未提供 PO Incoterm 或供应商国家/地址，${coverage.unclassified} 张 PO 保持未分类。`;
}
