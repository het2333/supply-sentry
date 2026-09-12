export type PortfolioRiskFactor = {
  code: string;
  label: string;
  score: number;
  evidence: string;
};

const reasonByCode: Record<string, string> = {
  supplier_no_response: "未获承诺",
  rihd_overdue: "RIHD 逾期",
  manufacturing_lead_time_shortfall: "交期风险",
  approval_pending: "待审批",
  production_delayed: "生产延误",
  production_blocked: "生产受阻",
  connector_failed: "执行失败",
  transport_exception: "运输异常",
  customs_held: "清关滞留",
  shipment_eta_overdue: "ETA 逾期",
};

const stageLabels: Record<string, string> = {
  po_sent: "采购订单已发送",
  supplier_commitment: "供应商承诺",
  fulfilment_production: "履约 / 生产",
  dispatch_transit: "发运 / 在途",
  delivery_grn: "交付 / 收货",
  completed: "已完成",
};

const materialTypeLabels: Record<string, string> = {
  direct: "直接物料",
  indirect: "间接物料",
  service: "服务",
};

export function routeStageLabel(stage: string, fallback: string): string {
  return stageLabels[stage] ?? fallback;
}

export function routeMaterialTypeLabel(value: string): string {
  return materialTypeLabels[value.trim().toLowerCase()] ?? value;
}

export function routeRiskReason(riskFactors: PortfolioRiskFactor[]): string | null {
  const factor = riskFactors.reduce<PortfolioRiskFactor | null>((highest, candidate) =>
    !highest || candidate.score > highest.score ? candidate : highest, null);
  if (!factor) return null;
  if (factor.code.startsWith("import_documents:")) return "单证风险";
  if (factor.code === "exception:manual_purchase_order_risk") return "人工风险";
  if (factor.code.startsWith("exception:")) return "业务异常";
  return (reasonByCode[factor.code] ?? factor.label.trim()) || "业务风险";
}
