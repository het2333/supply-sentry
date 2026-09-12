import type { EntityId, ToolDescriptor } from '@readywork/core';
import { nowIso, uid } from '@readywork/core';

/**
 * 工具层（Tools）插件系统。
 * Tool = AI 如何碰现实世界：带权限（引擎前置校验）与成本（预算记账）的原子操作。
 * 以下是内存参考实现；真实 Connector（SAP/金蝶/邮箱/浏览器…）以插件形式注册同一接口。
 */

export interface ToolContext {
  employeeId: EntityId;
  taskId?: EntityId;
  businessObjectId?: EntityId;
}

export interface ToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
  cost?: number;
}

export interface ToolDef {
  id: string;
  name: string;
  description: string;
  actions: string[];
  execute(action: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private defs = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    this.defs.set(def.id, def);
  }

  get(id: string): ToolDef | undefined {
    return this.defs.get(id);
  }

  list(): ToolDescriptor[] {
    return [...this.defs.values()].map((d) => ({ id: d.id, name: d.name, actions: d.actions }));
  }

  async execute(id: string, action: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const def = this.defs.get(id);
    if (!def) return { ok: false, error: `工具未注册: ${id}` };
    if (!def.actions.includes(action)) return { ok: false, error: `工具 ${id} 不支持动作 ${action}` };
    return def.execute(action, args, ctx);
  }
}

// ---------------------------------------------------------------- 内存参考工具

export interface EmailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
  at: string;
}

/** Odoo 采购后端（鸭子类型，避免 tools 依赖 connectors）——OdooErpClient 天然满足 */
export interface OdooPoBackend {
  readPO(poNumber: string): Promise<{
    name: string;
    supplierName: string;
    supplierEmail: string;
    state: string;
    amountTotal: number;
    promiseDate: string | null;
  } | null>;
  updateETA(poNumber: string, eta: string): Promise<{ updated: number }>;
}

export class ErpTool implements ToolDef {
  id = 'erp';
  name = 'ERP';
  description = '采购域业务对象：需求/询价/订单（配置 Odoo 后端后 po.get/po.update 真实读写 Odoo）';
  actions = ['requisition.create', 'rfq.create', 'rfq.addQuote', 'rfq.award', 'po.get', 'po.update', 'po.close', 'invoice.update'];

  readonly requisitions = new Map<string, Record<string, unknown>>();
  readonly rfqs = new Map<string, Record<string, unknown>>();
  readonly pos = new Map<string, Record<string, unknown>>();
  readonly invoices = new Map<string, Record<string, unknown>>();

  constructor(private odoo?: OdooPoBackend) {}

  async execute(action: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const id = (args.id as string) ?? (args[action] as string) ?? (ctx.businessObjectId as string);
    switch (action) {
      case 'requisition.create': {
        const rid = String(args.requisitionId ?? id);
        const rec = {
          id: rid,
          item: args.item,
          qty: args.qty,
          amount: args.amount,
          status: 'approved',
          createdAt: nowIso(),
          createdBy: ctx.employeeId,
        };
        this.requisitions.set(rid, rec);
        return { ok: true, data: { requisition: rec }, cost: 0.1 };
      }
      case 'rfq.create': {
        const rid = String(args.rfqId ?? id);
        const rfq = {
          id: rid,
          item: args.item,
          qty: args.qty,
          suppliers: String(args.suppliers ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          quotes: [] as Record<string, unknown>[],
          status: 'open',
          createdAt: nowIso(),
        };
        this.rfqs.set(rid, rfq);
        return { ok: true, data: { rfq }, cost: 0.1 };
      }
      case 'rfq.addQuote': {
        const rfq = this.rfqs.get(String(args.rfqId ?? id));
        if (!rfq) return { ok: false, error: `RFQ 不存在: ${args.rfqId}` };
        const quotes = rfq['quotes'] as Record<string, unknown>[];
        quotes.push({
          supplierId: args.supplierId,
          unitPrice: args.unitPrice,
          deliveryDays: args.deliveryDays,
          receivedAt: nowIso(),
        });
        return { ok: true, data: { rfq }, cost: 0.05 };
      }
      case 'rfq.award': {
        const rfq = this.rfqs.get(String(args.rfqId ?? id));
        if (!rfq) return { ok: false, error: `RFQ 不存在: ${args.rfqId}` };
        rfq['awardedTo'] = args.supplierId;
        rfq['status'] = 'awarded';
        return { ok: true, data: { rfq }, cost: 0.1 };
      }
      case 'po.get': {
        const poName = String(args.poId ?? id);
        if (this.odoo) {
          const po = await this.odoo.readPO(poName);
          if (!po) return { ok: false, error: `Odoo 未找到 PO: ${poName}` };
          return {
            ok: true,
            data: {
              po: {
                id: po.name,
                name: po.name,
                supplierId: po.supplierName,
                supplierName: po.supplierName,
                supplierEmail: po.supplierEmail,
                promiseDate: po.promiseDate,
                state: po.state,
                amountTotal: po.amountTotal,
                source: 'odoo',
              },
            },
            cost: 0.1,
          };
        }
        const po = this.pos.get(poName);
        return po ? { ok: true, data: { po }, cost: 0.1 } : { ok: false, error: `PO 不存在: ${poName}` };
      }
      case 'po.update': {
        const poName = String(args.poId ?? id);
        const field = String(args.field ?? '');
        if (field === 'unitPrice' || field === 'price') {
          return { ok: false, error: '采购价格不可修改（工具层防护）' };
        }
        if (this.odoo) {
          if (field === 'promiseDate' || field === 'date_planned') {
            const res = await this.odoo.updateETA(poName, String(args.value ?? ''));
            return { ok: true, data: { po: { id: poName, promiseDate: args.value, odoo: res }, source: 'odoo' }, cost: 0.1 };
          }
          return { ok: false, error: `Odoo 模式暂不支持修改字段: ${field}` };
        }
        const po = this.pos.get(poName);
        if (!po) return { ok: false, error: `PO 不存在: ${poName}` };
        po[field] = args.value;
        po['updatedAt'] = nowIso();
        return { ok: true, data: { po }, cost: 0.1 };
      }
      case 'po.close': {
        const poName = String(args.poId ?? id);
        if (this.odoo) {
          // 真实关闭 Odoo 采购单需走 Odoo 状态机（button_done/button_cancel），演示只记录本地状态
          return { ok: true, data: { po: { id: poName, status: 'closed' }, note: 'Odoo 关闭订单需状态机，演示略' }, cost: 0.1 };
        }
        const po = this.pos.get(poName);
        if (!po) return { ok: false, error: `PO 不存在: ${poName}` };
        po['status'] = 'closed';
        po['closedAt'] = nowIso();
        return { ok: true, data: { po }, cost: 0.1 };
      }
      case 'invoice.update': {
        const invoiceId = String(args.invoiceId ?? args.id ?? '');
        if (!invoiceId) return { ok: false, error: '发票 ID 必填' };
        const invoice = this.invoices.get(invoiceId) ?? { id: invoiceId };
        for (const key of ['matchResult', 'approvalStatus', 'payableStatus', 'holdReason']) {
          if (args[key] !== undefined) invoice[key] = args[key];
        }
        invoice['updatedAt'] = nowIso();
        this.invoices.set(invoiceId, invoice);
        return { ok: true, data: { invoice, source: 'memory' }, cost: 0.1 };
      }
      default:
        return { ok: false, error: `未知动作: ${action}` };
    }
  }
}

export interface Mailer {
  send(input: { to: string; subject: string; body: string }): Promise<{ ok: boolean; message?: string }>;
}

export class EmailTool implements ToolDef {
  id = 'email';
  name = '企业邮箱';
  description = '发件箱 + 收件箱；配置 Mailer 后真实发信（如网易 SMTP）';
  actions = ['send', 'inbox.push', 'inbox.list', 'outbox.list'];

  readonly inbox: EmailMessage[] = [];
  readonly outbox: EmailMessage[] = [];

  constructor(private mailer?: Mailer) {}

  async execute(action: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (action) {
      case 'send': {
        const to = (Array.isArray(args.to) ? args.to : String(args.to ?? '').split(',')).map((s) =>
          String(s).trim(),
        ).filter(Boolean);
        const msg: EmailMessage = {
          id: uid('email'),
          from: 'ai.workforce@readywork.local',
          to,
          subject: String(args.subject ?? ''),
          body: String(args.body ?? ''),
          at: nowIso(),
        };
        let real: { ok: boolean; message?: string } | undefined;
        if (this.mailer) {
          const results = [];
          for (const t of to) results.push(await this.mailer.send({ to: t, subject: msg.subject, body: msg.body }));
          real = results.find((r) => !r.ok) ?? results[0];
        }
        // 把真实发信结果一并写入发件箱，便于时间线/审计回查
        this.outbox.push({ ...msg, realSent: real?.ok === true, mailMessage: real?.message } as EmailMessage & { realSent?: boolean; mailMessage?: string });
        return { ok: true, data: { messageId: msg.id, to, realSent: real?.ok === true, mailMessage: real?.message }, cost: 0.05 };
      }
      case 'inbox.push': {
        // 模拟外部供应商来信（演示/测试辅助）
        const msg: EmailMessage = {
          id: uid('email'),
          from: String(args.from ?? ''),
          to: ['ai.workforce@readywork.local'],
          subject: String(args.subject ?? ''),
          body: String(args.body ?? ''),
          at: nowIso(),
        };
        this.inbox.push(msg);
        return { ok: true, data: { messageId: msg.id } };
      }
      case 'inbox.list':
        return { ok: true, data: { messages: [...this.inbox] } };
      case 'outbox.list':
        return { ok: true, data: { messages: [...this.outbox] } };
      default:
        return { ok: false, error: `未知动作: ${action}` };
    }
  }
}

export class PdfTool implements ToolDef {
  id = 'pdf';
  name = 'PDF 解析（模拟）';
  description = '从 PDF 提取文本（真实实现对接解析引擎）';
  actions = ['parse'];

  async execute(_action: string, args: Record<string, unknown>): Promise<ToolResult> {
    return { ok: true, data: { text: String(args.text ?? '') }, cost: 0.2 };
  }
}

export class ExcelTool implements ToolDef {
  id = 'excel';
  name = 'Excel（内存模拟）';
  description = '表格追加/读取';
  actions = ['appendRow', 'read'];

  readonly sheets = new Map<string, unknown[][]>();

  async execute(action: string, args: Record<string, unknown>): Promise<ToolResult> {
    const sheet = String(args.sheet ?? 'Sheet1');
    if (action === 'appendRow') {
      const rows = this.sheets.get(sheet) ?? [];
      const row = Array.isArray(args.row) ? (args.row as unknown[]) : [];
      rows.push(row);
      this.sheets.set(sheet, rows);
      return { ok: true, data: { sheet, rowIndex: rows.length - 1 }, cost: 0.05 };
    }
    if (action === 'read') {
      return { ok: true, data: { sheet, rows: this.sheets.get(sheet) ?? [] } };
    }
    return { ok: false, error: `未知动作: ${action}` };
  }
}

export function createReferenceTools(mailer?: Mailer, odoo?: OdooPoBackend): ToolDef[] {
  return [new ErpTool(odoo), new EmailTool(mailer), new PdfTool(), new ExcelTool()];
}
