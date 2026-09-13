// Curated ambiguous labels take precedence over the reverse legacy dictionary.
export const ENGLISH_UI_OVERRIDES: Readonly<Record<string, string>> = {
  "本地采购": "Local Procurement",
  "进口采购": "Import Procurement",
  "供应商": "Suppliers",
  "采购订单号": "PO Number",
  "行项目（{0}）": "Line items ({0})",
  "总金额（{0}）：": "Total amount ({0}):",
  "保存更改": "Save changes",
  "通知中心": "Notification Center",
  "概览": "Overview",
  "总览": "Overview",
  "报表": "Reports",
  "风险看板": "Risk Dashboard",
  "自动跟单": "Automated Follow-up",
  "收货": "Goods Receipt",
  "天": "days",
  "启用": "Active",
  "采购需求": "Purchase Requisitions",
  "显示第 {0} 至 {1} 项，共 {2} 项": "Showing {0} to {1} of {2} entries",
  "编辑供应商 {0}": "Edit supplier {0}",
  "Readywork — 采购执行工作区": "SupplySentry — Procurement Workspace",
  "SupplySentry — 采购执行工作区": "SupplySentry — Procurement Workspace",
  "履约 / 生产": "Fulfillment / Production",
  "采购订单发出，并保留连接器回执或 ERP 状态证据": "Send the purchase order and retain the connector receipt or ERP status evidence",
  "收集供应商对数量、价格与承诺交期的确认": "Collect supplier confirmation of quantity, price and committed delivery date",
  "跟踪供应商备货、生产与履约进度": "Track supplier preparation, production and fulfillment progress",
  "记录发运事实并持续跟踪在途状态": "Record dispatch evidence and track goods in transit",
  "用 ERP / 仓库收货事实核验最终到货": "Verify final delivery against ERP or warehouse goods-receipt records",
  "尚无已确认的本地采购订单": "No confirmed local purchase orders yet",
  "尚无已确认的进口采购订单": "No confirmed import purchase orders yet",
  "本地采购：高风险": "Local Procurement: High Risk",
  "本地采购：等待供应商": "Local Procurement: Awaiting Supplier",
  "本地采购：交付风险": "Local Procurement: Delivery Risk",
  "本地采购：进度正常": "Local Procurement: On Track",
  "进口采购：高风险": "Import Procurement: High Risk",
  "进口采购：等待供应商": "Import Procurement: Awaiting Supplier",
  "进口采购：交付风险": "Import Procurement: Delivery Risk",
  "进口采购：进度正常": "Import Procurement: On Track",
  "健康：真实适配器已加载": "Health: Live adapter loaded",
  "健康：运行时正常；尚未配置必需凭据": "Health: Runtime healthy; required credentials are not configured",
  "真实适配器已加载": "Live adapter loaded",
  "运行时正常；尚未配置必需凭据": "Runtime healthy; required credentials are not configured",
  "DeepSeek 官方 API": "Official DeepSeek API",
  "启用WhatsApp 智能体": "Enable WhatsApp Agent",
  "收到供应商消息：": "Supplier message received:",
  "已生成外发消息：": "Outbound message created:",
  "尝试": "Attempt",
  "1 张采购订单需要人工决策。": "1 purchase order requires a human decision.",
  ...Object.fromEntries(Object.entries({
    "总览": "Overview", "概览": "Overview", "采购订单": "Purchase Orders",
    "本地采购": "Local Procurement", "进口采购": "Import Procurement",
    "通知": "Notifications", "通知中心": "Notification Center",
    "风险看板": "Risk Dashboard", "来源页面": "Source page",
  }).flatMap(([source, target]) => [
    [`返回${source}`, `Back to ${target}`],
    [`· 返回${source}`, `· Back to ${target}`],
  ])),
};

// Match complete, catalogued messages only. Captures are business facts and must
// never be run through the dictionary (e.g. a supplier actually named “设置”).
export function compileMessageTemplates(catalog: Readonly<Record<string, string>>) {
  return Object.entries(catalog).filter(([key]) => /\{\d+\}/.test(key)).map(([source, target]) => {
    const slots: string[] = [];
    const escaped = source.split(/(\{\d+\})/g).map((part) => {
      if (/^\{\d+\}$/.test(part)) { slots.push(part); return "(.+?)"; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }).join("");
    const literals = source.split(/\{\d+\}/g);
    return { pattern: new RegExp(`^${escaped}$`, "u"), prefix: literals[0], suffix: literals[literals.length - 1], target, slots, specificity: source.replace(/\{\d+\}/g, "").length };
  }).sort((a, b) => b.specificity - a.specificity);
}
