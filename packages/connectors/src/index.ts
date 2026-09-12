import type { EntityId } from '@readywork/core';
import { NetEaseMailConnector } from './neteasemail.js';

export { NetEaseMailConnector } from './neteasemail.js';
export { sendMail } from './smtp.js';
export type { SendMailInput, SendMailResult } from './smtp.js';
export { OdooErpClient, OdooErpAdapter, OdooPurchaseOrderCancellationRejectedError, purchaseOrderDraftOrigin } from './odoo.js';
export type { OdooConfig, OdooPo, OdooPoLine, OdooPurchaseOrderDraftLineInput, OdooPurchaseOrderDraftInput, OdooPurchaseOrderDraft, OdooPurchaseOrderCancellationResult, OdooBoard, OdooMetrics, OdooSupplierRow, OdooSupplierContact, OdooSupplierMaster, OdooSupplierMasterIssue, OdooSupplierMasterResult, OdooInvoiceLine, OdooVendorInvoice, OdooReceiptLine, OdooGoodsReceipt, OdooInvoiceMatchResult, OdooInvoiceMatchUpdate } from './odoo.js';
export { ImapClient } from './imap.js';
export type { FetchUnseenOptions, ImapConfig, InboundEmail } from './imap.js';
export { extractPoNumber, pollInboundMail } from './mail-router.js';
export type { MailRouteHandler } from './mail-router.js';

/**
 * 连接器插件 —— AI 如何碰企业系统（SAP/金蝶/用友/企业微信…）。
 * 真实实现需对接各系统 SDK；此处提供端口 + stub（模拟握手），
 * 生产接入时替换 StubConnector 的真实实现即可，前端零改动。
 */

export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectorDef {
  id: string;
  name: string;
  category: string;
  description: string;
  status(): ConnectorStatus;
  connect(): Promise<{ ok: boolean; message?: string }>;
  disconnect(): Promise<{ ok: boolean }>;
}

export class StubConnector implements ConnectorDef {
  private current: ConnectorStatus = 'disconnected';

  constructor(
    public id: string,
    public name: string,
    public category: string,
    public description: string,
  ) {}

  status(): ConnectorStatus {
    return this.current;
  }

  async connect(): Promise<{ ok: boolean; message?: string }> {
    this.current = 'connecting';
    await new Promise((r) => setTimeout(r, 300));
    this.current = 'connected';
    return { ok: true, message: `${this.name} 握手成功（模拟）` };
  }

  async disconnect(): Promise<{ ok: boolean }> {
    this.current = 'disconnected';
    return { ok: true };
  }
}

export class ConnectorRegistry {
  private defs = new Map<string, ConnectorDef>();

  register(def: ConnectorDef): void {
    this.defs.set(def.id, def);
  }

  get(id: string): ConnectorDef | undefined {
    return this.defs.get(id);
  }

  list(): ConnectorDef[] {
    return [...this.defs.values()];
  }
}

/** 预置企业连接器（真实系统 SDK 接入点；网易邮箱为真实 SMTP 发信） */
export function createStubConnectors(): ConnectorDef[] {
  return [
    new StubConnector('sap', 'SAP', 'ERP', 'SAP ECC / S4HANA 采购与库存'),
    new StubConnector('kingdee', '金蝶', 'ERP', '金蝶云星空 / KIS'),
    new StubConnector('yonyou', '用友', 'ERP', '用友 U8 / NC / YonSuite'),
    new StubConnector('salesforce', 'Salesforce', 'CRM', '销售云与客户数据'),
    new StubConnector('wecom', '企业微信', 'IM', '企业微信会话与审批'),
    new StubConnector('dingtalk', '钉钉', 'IM', '钉钉工作通知与 OA'),
    new StubConnector('feishu', '飞书', 'IM', '飞书消息与审批流'),
    new NetEaseMailConnector(),
  ];
}

export type { EntityId };
