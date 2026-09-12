/**
 * ERP 适配层 —— 统一内部标准模型，不绑定具体 ERP（SAP/用友/金蝶/鼎捷/Odoo/…）。
 * 业务层只依赖 ErpAdapter 端口；每个 ERP 提供自己的适配实现，换 ERP 不重写员工。
 */

export interface ErpPurchaseOrderLine {
  id: number;
  product: string;
  qty: number;
  priceUnit: number;
  datePlanned: string | null;
}

export interface ErpPurchaseOrder {
  id: number;
  name: string; // ERP 单号（如 P00011）
  supplierId: string;
  supplierName: string;
  supplierEmail: string;
  state: string;
  amountTotal: number;
  amountUntaxed: number;
  dateOrder: string;
  promiseDate: string | null; // 承诺交期（date_planned）
  lines: ErpPurchaseOrderLine[];
}

export interface ErpReceipt {
  name: string;
  poName: string;
  state: string;
  date: string;
}

export interface ErpVendorBill {
  id: number;
  name: string;
  supplierName: string;
  poName: string;
  amountTotal: number;
  state: string;
  date: string;
}

export interface ErpAdapter {
  readPurchaseOrder(poNumber: string): Promise<ErpPurchaseOrder | null>;
  listPurchaseOrders(): Promise<ErpPurchaseOrder[]>;
  updatePurchaseOrderETA(poNumber: string, eta: string): Promise<{ updated: number }>;
  listReceipts(): Promise<ErpReceipt[]>;
  listVendorBills(): Promise<ErpVendorBill[]>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
