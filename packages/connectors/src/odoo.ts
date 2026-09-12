/**
 * Odoo 19 JSON-2 External API 客户端（真实 ERP 读写）。
 *
 * 协议（Odoo 官方 External API，注意与旧 XML-RPC 不同）：
 *   POST {baseUrl}/json/2/{model}/{method}
 *   Headers:
 *     content-type: application/json; charset=utf-8
 *     authorization: bearer <API_KEY>
 *     x-odoo-database: <database>
 *   Body: 直接是 ORM 方法参数对象（domain / fields / ids / vals / context ...）
 *
 * 采购场景映射：
 *   purchase.order       search_read → 读采购订单（date_planned 在订单头）
 *   purchase.order.line  search_read → 读订单行（date_planned 真正生效的位置）
 *   purchase.order.line  write       → 写回承诺交期（date_planned）
 */

export interface OdooConfig {
  baseUrl: string; // 如 http://127.0.0.1:8069
  database: string; // Odoo 数据库名，如 zhuxu_demo
  apiKey: string; // Odoo API Key（设置 → 用户 → API Keys 生成）
  timeoutMs?: number;
}

export interface OdooPoLine {
  id: number;
  productId?: number;
  product: string;
  unit: string;
  qty: number;
  priceUnit: number;
  datePlanned: string | null;
}

export interface OdooPo {
  id: number;
  name: string; // P00011
  supplierId: string; // odoo-<partnerId>
  supplierName: string;
  supplierEmail: string;
  currency: string;
  state: string;
  amountTotal: number;
  amountUntaxed: number;
  dateOrder: string;
  /** Odoo purchase.order.date_approve; authoritative UTC confirmation time for an issued PO. */
  confirmedAt?: string;
  promiseDate: string | null; // 订单行 date_planned（取第一条）
  /** Odoo purchase.order.incoterm_id. Read-only route evidence; never treated as a route decision. */
  incotermId?: number;
  incotermName?: string;
  /** Odoo purchase.order.incoterm_location. */
  incotermLocation?: string;
  /** Odoo purchase.order.dest_address_id. */
  dropshipAddressId?: number;
  dropshipAddressName?: string;
  /** Odoo purchase.order.picking_type_id. This is operational context, not proof of local/import. */
  deliveryOperationTypeId?: number;
  deliveryOperationTypeName?: string;
  lines: OdooPoLine[];
}

/** The small, explicit write contract used when Readywork creates an Odoo PO draft. */
export interface OdooPurchaseOrderDraftLineInput {
  /** Odoo product.product.default_code. */
  itemCode: string;
  quantity: number;
  priceUnit: number;
  /** Optional text shown on the purchase-order line. */
  description?: string;
  /** Odoo datetime/date accepted by purchase.order.line.date_planned. */
  datePlanned?: string;
}

export interface OdooPurchaseOrderDraftInput {
  /** Stable business id supplied by the caller; it is made into the Odoo origin. */
  correlationKey: string;
  /** Numeric Odoo res.partner id (a legacy `odoo-123` value is also accepted). */
  partnerId: number | string;
  /** Odoo res.currency.name, for example CNY or USD. */
  currencyCode: string;
  lines: OdooPurchaseOrderDraftLineInput[];
}

export interface OdooPurchaseOrderDraft {
  id: number;
  /** Actual sequence-generated Odoo purchase.order.name. */
  name: string;
  origin: string;
  partnerId: number;
  currencyId: number;
  state: 'draft';
  lineCount: number;
  /** True when the existing PO for this correlation key was returned. */
  replayed: boolean;
}

export interface OdooPurchaseOrderCancellationResult {
  id: number;
  name: string;
  state: 'cancel';
  /** True when reconciliation found the PO already cancelled. */
  replayed: boolean;
}

/** Odoo definitively refused the cancellation; the outcome is not ambiguous. */
export class OdooPurchaseOrderCancellationRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OdooPurchaseOrderCancellationRejectedError';
  }
}

export interface OdooSupplierRow {
  id: number;
  name: string;
  country: string;
  openOrders: number;
  totalOrders: number;
  spend: number;
  overdue: boolean;
}

export interface OdooSupplierContact {
  name: string;
  email: string;
  phone: string;
}

export interface OdooSupplierMaster {
  externalId: string;
  name: string;
  currency: string;
  contacts: OdooSupplierContact[];
  countryCode?: string;
  countryName?: string;
  city?: string;
  street?: string;
  street2?: string;
  postalCode?: string;
  status: 'active' | 'inactive';
  sourceSystem: 'odoo';
}

export interface OdooSupplierMasterIssue {
  row: number;
  reason: 'missing_id' | 'missing_name';
}

export interface OdooSupplierMasterResult {
  items: OdooSupplierMaster[];
  issues: OdooSupplierMasterIssue[];
}

export interface OdooMetrics {
  openOrders: number;
  activeSuppliers: number;
  riskAmount: number;
  totalOrders: number;
}

export interface OdooBoard {
  suppliers: OdooSupplierRow[];
  metrics: OdooMetrics;
}

export interface OdooInvoiceLine {
  id: number;
  productId?: number;
  product: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  taxIds: number[];
  currency: string;
  poLineId?: number;
  poId?: number;
}

export interface OdooVendorInvoice {
  id: number;
  name: string;
  supplierId: number;
  supplierName: string;
  poName: string;
  currency: string;
  amountTotal: number;
  amountUntaxed: number;
  state: string;
  paymentState: string;
  date: string;
  createdAt: string;
  updatedAt: string;
  lines: OdooInvoiceLine[];
}

export interface OdooReceiptLine {
  id: number;
  productId?: number;
  product: string;
  quantity: number;
  unit: string;
  poLineId?: number;
  moveId?: number;
}

export interface OdooGoodsReceipt {
  id: number;
  name: string;
  poName: string;
  state: string;
  scheduledDate: string;
  doneDate: string;
  warehouseLocationId?: number;
  warehouseLocationName: string;
  createdAt: string;
  updatedAt: string;
  lines: OdooReceiptLine[];
}

/** V1 唯一的三单匹配结果枚举；写回 Odoo 时必须使用这些 canonical 值。 */
export type OdooInvoiceMatchResult = 'exact_match' | 'within_tolerance' | 'approval_required' | 'severe_exception';
export interface OdooInvoiceMatchUpdate {
  matchResult?: OdooInvoiceMatchResult;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  payableStatus?: 'payable' | 'hold' | 'not_payable';
  holdReason?: string;
}

const INVOICE_MATCH_RESULTS = new Set<OdooInvoiceMatchResult>(['exact_match', 'within_tolerance', 'approval_required', 'severe_exception']);
const INVOICE_APPROVAL_STATUSES = new Set<NonNullable<OdooInvoiceMatchUpdate['approvalStatus']>>(['pending', 'approved', 'rejected']);
const INVOICE_PAYABLE_STATUSES = new Set<NonNullable<OdooInvoiceMatchUpdate['payableStatus']>>(['payable', 'hold', 'not_payable']);

const INVOICE_MATCH_FIELDS = {
  matchResult: 'readywork_match_result',
  approvalStatus: 'readywork_approval_status',
  payableStatus: 'readywork_payable_status',
  holdReason: 'readywork_hold_reason',
} as const;

export class OdooErpClient {
  constructor(readonly config: OdooConfig) {}

  /** 调用 Odoo JSON-2 方法，返回 result。 */
  private async call(model: string, method: string, body: Record<string, unknown>): Promise<unknown> {
    try {
      const res = await fetch(`${this.config.baseUrl}/json/2/${model}/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `bearer ${this.config.apiKey}`,
          'x-odoo-database': this.config.database,
          'user-agent': 'readywork-ai-workforce',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Odoo ${model}.${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return await res.json();
    } catch (error) {
      throw new Error(redactOdooError(error));
    }
  }

  private async searchRead(model: string, domain: unknown[], fields: string[], pageSize = 200): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [];
    const seen = new Set<number>();
    for (let page = 0; page < 100; page += 1) {
      const batch = (await this.call(model, 'search_read', { domain, fields, offset: page * pageSize, limit: pageSize })) as Array<Record<string, unknown>>;
      if (!Array.isArray(batch) || batch.length === 0) break;
      let added = 0;
      for (const row of batch) {
        const id = Number(row.id);
        if (!Number.isFinite(id) || seen.has(id)) continue;
        seen.add(id); rows.push(row); added += 1;
      }
      if (batch.length < pageSize || added === 0) break;
    }
    return rows;
  }

  /**
   * Creates a purchase-order draft exactly once for a business correlation key.
   *
   * `origin` is the durable idempotency record in Odoo.  In particular, a failed
   * or timed-out create is reconciled by searching this origin, never by issuing a
   * second create request.
   */
  async createPurchaseOrderDraft(input: OdooPurchaseOrderDraftInput): Promise<OdooPurchaseOrderDraft> {
    const request = normalizePurchaseOrderDraftInput(input);
    const origin = purchaseOrderDraftOrigin(request.correlationKey);
    const existing = await this.findPurchaseOrderDraft(origin);
    if (existing) return this.verifyPurchaseOrderDraft(existing, request, origin, true);

    const partners = await this.searchRead('res.partner', [['id', '=', request.partnerId]], ['id', 'name', 'active', 'supplier_rank'], 2);
    if (partners.length !== 1 || asOptionalId(partners[0]?.id) !== request.partnerId || partners[0]?.active === false) {
      throw new Error(`purchase-order draft 未找到唯一有效供应商: ${request.partnerId}`);
    }

    const products: Array<{ id: number; uomPoId: number; displayName: string }> = [];
    for (const line of request.lines) {
      const rows = await this.searchRead('product.product', [['default_code', '=', line.itemCode]], ['id', 'display_name', 'uom_po_id'], 2);
      if (rows.length === 0) throw new Error(`purchase-order draft 未找到可采购产品编码: ${line.itemCode}`);
      if (rows.length > 1) throw new Error(`purchase-order draft 产品编码映射不唯一: ${line.itemCode}`);
      const product = rows[0];
      const productId = asOptionalId(product?.id);
      const uomPoId = asOptionalId(product?.uom_po_id);
      if (!productId || !uomPoId) throw new Error(`purchase-order draft 未找到可采购产品编码: ${line.itemCode}`);
      products.push({ id: productId, uomPoId, displayName: String(product?.display_name ?? line.itemCode) });
    }

    const currencies = await this.searchRead('res.currency', [['name', '=', request.currencyCode]], ['id', 'name'], 2);
    if (currencies.length === 0) throw new Error(`purchase-order draft 未找到币种: ${request.currencyCode}`);
    if (currencies.length > 1) throw new Error(`purchase-order draft 币种映射不唯一: ${request.currencyCode}`);
    const currencyId = asOptionalId(currencies[0]?.id);
    if (!currencyId) throw new Error(`purchase-order draft 未找到币种: ${request.currencyCode}`);

    const vals = {
      origin,
      partner_id: request.partnerId,
      currency_id: currencyId,
      state: 'draft',
      order_line: request.lines.map((line, index) => [0, 0, {
        product_id: products[index]!.id,
        product_uom: products[index]!.uomPoId,
        product_qty: line.quantity,
        price_unit: line.priceUnit,
        name: line.description ?? products[index]!.displayName,
        ...(line.datePlanned ? { date_planned: normalizeEta(line.datePlanned) } : {}),
      }]),
    };

    try {
      await this.call('purchase.order', 'create', { vals });
    } catch (error) {
      // The server may have committed the create before a proxy/client timeout.
      // Reconcile once; do not retry the non-idempotent create request.
      try {
        const reconciled = await this.findPurchaseOrderDraft(origin);
        if (reconciled) return this.verifyPurchaseOrderDraft(reconciled, request, origin, true);
      } catch {
        // Preserve the original, redacted create failure below.
      }
      throw error;
    }

    const created = await this.findPurchaseOrderDraft(origin);
    if (!created) throw new Error(`purchase-order draft 创建后无法按 origin 读取: ${origin}`);
    return this.verifyPurchaseOrderDraft(created, request, origin, false);
  }

  private async findPurchaseOrderDraft(origin: string): Promise<Record<string, unknown> | null> {
    const orders = await this.searchRead('purchase.order', [['origin', '=', origin]], ['id', 'name', 'origin', 'partner_id', 'currency_id', 'state', 'order_line'], 2);
    if (orders.length > 1) throw new Error(`purchase-order draft correlationKey 对应多个订单: ${origin}`);
    return orders[0] ?? null;
  }

  private verifyPurchaseOrderDraft(order: Record<string, unknown>, input: NormalizedPurchaseOrderDraftInput, origin: string, replayed: boolean): OdooPurchaseOrderDraft {
    const id = asOptionalId(order.id);
    const name = typeof order.name === 'string' ? order.name.trim() : '';
    const partnerId = asMany2One(order.partner_id)[0];
    const currencyId = asMany2One(order.currency_id)[0];
    const lineCount = asIds(order.order_line).length;
    if (!id || !name || order.origin !== origin || partnerId !== input.partnerId || order.state !== 'draft' || lineCount !== input.lines.length) {
      throw new Error(`purchase-order draft 写入核验不一致: ${origin}`);
    }
    return { id, name, origin, partnerId, currencyId, state: 'draft', lineCount, replayed };
  }

  /** 读取指定采购订单（含订单行） */
  async readPO(poNumber: string): Promise<OdooPo | null> {
    const orders = (await this.call('purchase.order', 'search_read', {
      domain: [['name', '=', poNumber]],
      fields: [
        'name', 'partner_id', 'date_order', 'amount_total', 'amount_untaxed', 'state', 'currency_id', 'order_line',
        'date_approve', 'incoterm_id', 'incoterm_location', 'dest_address_id', 'picking_type_id',
      ],
      limit: 5,
    })) as Array<Record<string, unknown>>;
    if (!orders.length) return null;
    const o = orders[0]!;
    const orderId = o.id as number;
    const lineIds = (o.order_line as number[]) ?? [];
    const lines = lineIds.length
      ? ((await this.call('purchase.order.line', 'search_read', {
          domain: [['id', 'in', lineIds]],
          fields: ['id', 'product_id', 'product_qty', 'product_uom_id', 'price_unit', 'date_planned'],
          limit: 200,
        })) as Array<Record<string, unknown>>)
      : [];
    const partner = (o.partner_id as [number, string]) ?? [0, ''];
    const supplierEmail = await this.partnerEmail(partner[0]);
    const incoterm = asMany2One(o.incoterm_id);
    const dropshipAddress = asMany2One(o.dest_address_id);
    const deliveryOperationType = asMany2One(o.picking_type_id);
    const incotermLocation = optionalString(o.incoterm_location);
    const confirmedAt = optionalString(o.date_approve);
    return {
      id: orderId,
      name: String(o.name),
      supplierId: `odoo-${partner[0]}`,
      supplierName: partner[1] ?? '',
      supplierEmail,
      currency: asMany2One(o.currency_id)[1],
      state: String(o.state ?? ''),
      amountTotal: Number(o.amount_total ?? 0),
      amountUntaxed: Number(o.amount_untaxed ?? 0),
      dateOrder: String(o.date_order ?? ''),
      ...(confirmedAt ? { confirmedAt } : {}),
      promiseDate: lines[0] ? ((lines[0].date_planned as string) ?? null) : null,
      ...(incoterm[0] > 0 ? { incotermId: incoterm[0], incotermName: incoterm[1] } : {}),
      ...(incotermLocation ? { incotermLocation } : {}),
      ...(dropshipAddress[0] > 0 ? { dropshipAddressId: dropshipAddress[0], dropshipAddressName: dropshipAddress[1] } : {}),
      ...(deliveryOperationType[0] > 0 ? {
        deliveryOperationTypeId: deliveryOperationType[0],
        deliveryOperationTypeName: deliveryOperationType[1],
      } : {}),
      lines: lines.map((l) => ({
        id: l.id as number,
        productId: asOptionalId(l.product_id),
        product: String(((l.product_id as [number, string]) ?? [0, ''])[1] ?? ''),
        unit: asMany2One(l.product_uom_id)[1],
        qty: Number(l.product_qty ?? 0),
        priceUnit: Number(l.price_unit ?? 0),
        datePlanned: (l.date_planned as string) ?? null,
      })),
    };
  }

  /** 读取全部采购订单（供列表/同步） */
  async listPOs(): Promise<OdooPo[]> {
    const orders = (await this.call('purchase.order', 'search_read', {
      domain: [],
      fields: ['name', 'partner_id', 'date_order', 'amount_total', 'state', 'order_line'],
      limit: 500,
    })) as Array<Record<string, unknown>>;
    const result: OdooPo[] = [];
    for (const o of orders) {
      const po = await this.readPO(String(o.name));
      if (po) result.push(po);
    }
    return result;
  }

  /** 更新订单承诺交期（写入 purchase.order.line.date_planned，订单交期真正生效位置） */
  async updateETA(poNumber: string, eta: string): Promise<{ updated: number; lines: number }> {
    const normalized = normalizeEta(eta);
    const lines = (await this.call('purchase.order.line', 'search_read', {
      domain: [['order_id.name', '=', poNumber]],
      fields: ['id'],
      limit: 200,
    })) as { id: number }[];
    if (!lines.length) throw new Error(`Odoo 未找到订单 ${poNumber} 的订单行`);
    await this.call('purchase.order.line', 'write', {
      ids: lines.map((l) => l.id),
      vals: { date_planned: normalized },
    });
    return { updated: lines.length, lines: lines.length };
  }

  /**
   * Cancel one Odoo PO through its business-state action and verify the result.
   * A timeout is reconciled by readback and the non-idempotent action is never
   * issued twice by this call.
   */
  async cancelPurchaseOrder(poNumber: string): Promise<OdooPurchaseOrderCancellationResult> {
    const name = poNumber.trim();
    if (!name) throw new Error('Odoo purchase-order cancellation requires a PO number');
    const before = await this.findPurchaseOrderForCancellation(name);
    if (before.state === 'cancel') return { ...before, state: 'cancel', replayed: true };
    if (!['draft', 'sent', 'to approve', 'purchase'].includes(before.state)) {
      throw new OdooPurchaseOrderCancellationRejectedError(`Odoo purchase order ${name} cannot be cancelled from state ${before.state}`);
    }

    let writeError: unknown;
    try {
      await this.call('purchase.order', 'button_cancel', { ids: [before.id] });
    } catch (error) {
      writeError = error;
    }

    let after: { id: number; name: string; state: string };
    try {
      after = await this.findPurchaseOrderForCancellation(name);
    } catch (readbackError) {
      throw writeError ?? readbackError;
    }
    if (after.id !== before.id || after.name !== before.name) {
      throw new Error(`Odoo purchase-order cancellation readback identity mismatch: ${name}`);
    }
    if (after.state === 'cancel') return { ...after, state: 'cancel', replayed: Boolean(writeError) };
    if (writeError && /Odoo purchase\.order\.button_cancel HTTP (?:400|401|403|404|405|409|422)\b/.test(String((writeError as Error).message ?? writeError))) {
      throw new OdooPurchaseOrderCancellationRejectedError(`Odoo rejected purchase-order cancellation: ${name}`);
    }
    if (writeError) throw writeError;
    throw new OdooPurchaseOrderCancellationRejectedError(`Odoo purchase order ${name} remained in state ${after.state}`);
  }

  private async findPurchaseOrderForCancellation(poNumber: string): Promise<{ id: number; name: string; state: string }> {
    const orders = await this.searchRead('purchase.order', [['name', '=', poNumber]], ['id', 'name', 'state'], 2);
    if (orders.length !== 1) throw new Error(`Odoo purchase-order cancellation requires one exact PO: ${poNumber}`);
    const id = asOptionalId(orders[0]?.id);
    const name = typeof orders[0]?.name === 'string' ? orders[0].name.trim() : '';
    const state = typeof orders[0]?.state === 'string' ? orders[0].state.trim() : '';
    if (!id || name !== poNumber || !state) throw new Error(`Odoo purchase-order cancellation readback is invalid: ${poNumber}`);
    return { id, name, state };
  }

  /** 供应商看板：一次拉取采购单 + 供应商，聚合出供应商维度的未结订单/采购额/逾期风险 */
  async board(): Promise<OdooBoard> {
    const orders = (await this.call('purchase.order', 'search_read', {
      domain: [],
      fields: ['name', 'partner_id', 'amount_total', 'state', 'date_planned'],
      limit: 1000,
    })) as Array<Record<string, unknown>>;
    const partners = (await this.call('res.partner', 'search_read', {
      domain: [['is_company', '=', true]],
      fields: ['id', 'name', 'country_id'],
      limit: 1000,
    })) as Array<Record<string, unknown>>;

    const now = Date.now();
    const isOverdue = (datePlanned: unknown): boolean => {
      const s = String(datePlanned ?? '');
      if (!s) return false;
      const t = Date.parse(s);
      return !Number.isNaN(t) && t < now;
    };

    const partnerMap = new Map<number, { name: string; country: string }>();
    for (const p of partners) {
      const cid = (p.country_id as [number, string] | false) ?? false;
      partnerMap.set(p.id as number, { name: String(p.name ?? ''), country: cid ? cid[1] : '' });
    }

    const agg = new Map<number, { openOrders: number; totalOrders: number; spend: number; overdue: boolean }>();
    let openOrders = 0;
    let riskAmount = 0;
    for (const o of orders) {
      const pid = ((o.partner_id as [number, string]) ?? [0, ''])[0] as number;
      const state = String(o.state ?? '');
      const amount = Number(o.amount_total ?? 0);
      const a = agg.get(pid) ?? { openOrders: 0, totalOrders: 0, spend: 0, overdue: false };
      a.totalOrders += 1;
      if (state === 'purchase' || state === 'sent' || state === 'to approve') {
        a.openOrders += 1;
        openOrders += 1;
        a.spend += amount;
        if (isOverdue(o.date_planned)) {
          a.overdue = true;
          riskAmount += amount;
        }
      }
      agg.set(pid, a);
    }

    const suppliers: OdooSupplierRow[] = [];
    for (const [pid, a] of agg) {
      const p = partnerMap.get(pid);
      if (!p || p.name === 'My Company') continue;
      suppliers.push({
        id: pid,
        name: p.name,
        country: p.country || '中国',
        openOrders: a.openOrders,
        totalOrders: a.totalOrders,
        spend: a.spend,
        overdue: a.overdue,
      });
    }
    suppliers.sort((x, y) => y.spend - x.spend);

    return {
      suppliers,
      metrics: { openOrders, activeSuppliers: suppliers.length, riskAmount, totalOrders: orders.length },
    };
  }

  /** 供应商发票（account.move in_invoice），供三单匹配 */
  async listVendorBills(): Promise<{ id: number; name: string; supplierName: string; poName: string; amountTotal: number; state: string; date: string }[]> {
    return (await this.listVendorInvoices()).map((b) => ({ id: b.id, name: b.name, supplierName: b.supplierName, poName: b.poName, amountTotal: b.amountTotal, state: b.state, date: b.date }));
  }

  /** 只读供应商主数据；不执行创建、准入或修改。 */
  async listSupplierMasters(): Promise<OdooSupplierMasterResult> {
    const rows = await this.searchRead('res.partner', [['supplier_rank', '>', 0]], ['id', 'name', 'email', 'phone', 'currency_id', 'country_id', 'city', 'street', 'street2', 'zip', 'active']);
    const countryIds = [...new Set(rows.map((row) => asMany2One(row.country_id)[0]).filter((id) => id > 0))];
    const countries = countryIds.length
      ? await this.searchRead('res.country', [['id', 'in', countryIds]], ['id', 'code', 'name'])
      : [];
    const countryById = new Map(countries.map((country) => [Number(country.id), {
      code: typeof country.code === 'string' ? country.code.trim().toUpperCase() : '',
      name: typeof country.name === 'string' ? country.name.trim() : '',
    }] as const));
    const items: OdooSupplierMaster[] = [];
    const issues: OdooSupplierMasterIssue[] = [];
    rows.forEach((row, index) => {
      const id = asOptionalId(row.id);
      if (!id) { issues.push({ row: index, reason: 'missing_id' }); return; }
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (!name) { issues.push({ row: index, reason: 'missing_name' }); return; }
      const email = typeof row.email === 'string' ? row.email.trim() : '';
      const phone = typeof row.phone === 'string' ? row.phone.trim() : '';
      const country = asMany2One(row.country_id);
      const countryRecord = countryById.get(country[0]);
      const countryCode = countryRecord?.code ?? '';
      const countryName = countryRecord?.name || country[1].trim();
      const city = typeof row.city === 'string' ? row.city.trim() : '';
      const street = typeof row.street === 'string' ? row.street.trim() : '';
      const street2 = typeof row.street2 === 'string' ? row.street2.trim() : '';
      const postalCode = typeof row.zip === 'string' ? row.zip.trim() : '';
      items.push({
        externalId: `odoo-partner-${id}`,
        name,
        currency: asMany2One(row.currency_id)[1],
        contacts: email || phone ? [{ name, email, phone }] : [],
        ...(countryCode ? { countryCode } : {}),
        ...(countryName ? { countryName } : {}),
        ...(city ? { city } : {}),
        ...(street ? { street } : {}),
        ...(street2 ? { street2 } : {}),
        ...(postalCode ? { postalCode } : {}),
        status: row.active === false ? 'inactive' : 'active',
        sourceSystem: 'odoo',
      });
    });
    return { items, issues };
  }

  /** 读取供应商发票头和发票行，并保留 purchase_line_id 关联。 */
  async listVendorInvoices(): Promise<OdooVendorInvoice[]> {
    const bills = await this.searchRead('account.move', [['move_type', '=', 'in_invoice']], ['id', 'name', 'partner_id', 'amount_total', 'amount_untaxed', 'state', 'payment_state', 'invoice_date', 'invoice_origin', 'currency_id', 'invoice_line_ids', 'create_date', 'write_date']);
    const result: OdooVendorInvoice[] = [];
    for (const bill of bills) {
      const lineIds = asIds(bill.invoice_line_ids);
      const lineRows = lineIds.length ? await this.searchRead('account.move.line', [['id', 'in', lineIds]], ['id', 'product_id', 'product_uom_id', 'quantity', 'price_unit', 'price_subtotal', 'tax_ids', 'currency_id', 'purchase_line_id', 'purchase_order_id']) : [];
      const partner = asMany2One(bill.partner_id);
      result.push({
        id: Number(bill.id), name: typeof bill.name === 'string' && bill.name ? bill.name : `BILL-${bill.id}`,
        supplierId: partner[0], supplierName: partner[1], poName: String(bill.invoice_origin ?? ''), currency: asMany2One(bill.currency_id)[1],
        amountTotal: finiteNumber(bill.amount_total), amountUntaxed: finiteNumber(bill.amount_untaxed), state: String(bill.state ?? ''), paymentState: String(bill.payment_state ?? ''), date: String(bill.invoice_date ?? '').slice(0, 10),
        createdAt: String(bill.create_date ?? ''), updatedAt: String(bill.write_date ?? bill.create_date ?? ''),
        lines: lineRows.map((line) => ({ id: Number(line.id), productId: asOptionalId(line.product_id), product: asMany2One(line.product_id)[1], unit: asMany2One(line.product_uom_id)[1], quantity: finiteNumber(line.quantity), unitPrice: finiteNumber(line.price_unit), subtotal: finiteNumber(line.price_subtotal), taxIds: asIds(line.tax_ids), currency: asMany2One(line.currency_id)[1], poLineId: asOptionalId(line.purchase_line_id), poId: asOptionalId(line.purchase_order_id) })),
      });
    }
    return result;
  }

  async readVendorInvoice(invoiceId: number): Promise<OdooVendorInvoice | null> {
    const bills = await this.searchRead('account.move', [['id', '=', invoiceId], ['move_type', '=', 'in_invoice']], ['id', 'name', 'partner_id', 'amount_total', 'amount_untaxed', 'state', 'payment_state', 'invoice_date', 'invoice_origin', 'currency_id', 'invoice_line_ids', 'create_date', 'write_date'], 20);
    if (!bills.length) return null;
    const original = await this.listVendorInvoicesByRows(bills);
    return original[0] ?? null;
  }

  private async listVendorInvoicesByRows(bills: Array<Record<string, unknown>>): Promise<OdooVendorInvoice[]> {
    const result: OdooVendorInvoice[] = [];
    for (const bill of bills) {
      const lineIds = asIds(bill.invoice_line_ids);
      const lineRows = lineIds.length ? await this.searchRead('account.move.line', [['id', 'in', lineIds]], ['id', 'product_id', 'product_uom_id', 'quantity', 'price_unit', 'price_subtotal', 'tax_ids', 'currency_id', 'purchase_line_id', 'purchase_order_id']) : [];
      const partner = asMany2One(bill.partner_id);
      result.push({
        id: Number(bill.id), name: typeof bill.name === 'string' && bill.name ? bill.name : `BILL-${bill.id}`,
        supplierId: partner[0], supplierName: partner[1], poName: String(bill.invoice_origin ?? ''), currency: asMany2One(bill.currency_id)[1],
        amountTotal: finiteNumber(bill.amount_total), amountUntaxed: finiteNumber(bill.amount_untaxed), state: String(bill.state ?? ''), paymentState: String(bill.payment_state ?? ''), date: String(bill.invoice_date ?? '').slice(0, 10),
        createdAt: String(bill.create_date ?? ''), updatedAt: String(bill.write_date ?? bill.create_date ?? ''),
        lines: lineRows.map((line) => ({ id: Number(line.id), productId: asOptionalId(line.product_id), product: asMany2One(line.product_id)[1], unit: asMany2One(line.product_uom_id)[1], quantity: finiteNumber(line.quantity), unitPrice: finiteNumber(line.price_unit), subtotal: finiteNumber(line.price_subtotal), taxIds: asIds(line.tax_ids), currency: asMany2One(line.currency_id)[1], poLineId: asOptionalId(line.purchase_line_id), poId: asOptionalId(line.purchase_order_id) })),
      });
    }
    return result;
  }

  /** 收货单（stock.picking incoming），按 origin 关联采购单 */
  async listReceipts(): Promise<{ name: string; poName: string; state: string; date: string }[]> {
    return (await this.listGoodsReceipts()).map((p) => ({ name: p.name, poName: p.poName, state: p.state, date: (p.doneDate || p.scheduledDate).slice(0, 10) }));
  }

  /** 读取收货头/行，行通过 purchase_line_id 关联 PO 行。 */
  async listGoodsReceipts(): Promise<OdooGoodsReceipt[]> {
    const picks = await this.searchRead('stock.picking', [['picking_type_code', '=', 'incoming']], ['id', 'name', 'state', 'scheduled_date', 'date_done', 'origin', 'location_dest_id', 'move_line_ids', 'create_date', 'write_date']);
    const result: OdooGoodsReceipt[] = [];
    for (const picking of picks) {
      const lineIds = asIds(picking.move_line_ids);
      // Odoo 19 将 stock.move.line.qty_done 统一为 quantity，采购行关系保存在 stock.move。
      const lines = lineIds.length ? await this.searchRead('stock.move.line', [['id', 'in', lineIds]], ['id', 'product_id', 'quantity', 'product_uom_id', 'move_id']) : [];
      const moveIds = lines.map((line) => asOptionalId(line.move_id)).filter((id): id is number => id !== undefined);
      const moves = moveIds.length ? await this.searchRead('stock.move', [['id', 'in', moveIds]], ['id', 'purchase_line_id']) : [];
      const purchaseLineByMove = new Map(moves.map((move) => [Number(move.id), asOptionalId(move.purchase_line_id)]));
      const destination = asMany2One(picking.location_dest_id);
      result.push({ id: Number(picking.id), name: String(picking.name ?? ''), poName: String(picking.origin ?? ''), state: String(picking.state ?? ''), scheduledDate: String(picking.scheduled_date ?? ''), doneDate: String(picking.date_done ?? ''), warehouseLocationId: destination[0] || undefined, warehouseLocationName: destination[1], createdAt: String(picking.create_date ?? ''), updatedAt: String(picking.write_date ?? picking.create_date ?? ''), lines: lines.map((line) => { const moveId = asOptionalId(line.move_id); return { id: Number(line.id), productId: asOptionalId(line.product_id), product: asMany2One(line.product_id)[1], quantity: finiteNumber(line.quantity ?? line.qty_done), unit: asMany2One(line.product_uom_id)[1], poLineId: moveId ? purchaseLineByMove.get(moveId) : undefined, moveId }; }) });
    }
    return result;
  }

  /** 仅更新三单匹配/审批/待付状态白名单，禁止任意模型或付款字段写入。 */
  async updateInvoiceMatch(invoiceId: number, update: OdooInvoiceMatchUpdate): Promise<OdooVendorInvoice> {
    if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw new Error('invoice.update 发票 ID 必须是正整数');
    if (!update || typeof update !== 'object' || Array.isArray(update)) throw new Error('invoice.update 必须提供更新对象');
    const allowedKeys = new Set<keyof OdooInvoiceMatchUpdate>(['matchResult', 'approvalStatus', 'payableStatus', 'holdReason']);
    const unknownKeys = Object.keys(update).filter((key) => !allowedKeys.has(key as keyof OdooInvoiceMatchUpdate));
    if (unknownKeys.length) throw new Error(`invoice.update 包含非白名单字段: ${unknownKeys.join(', ')}`);
    if (update.matchResult !== undefined && !INVOICE_MATCH_RESULTS.has(update.matchResult)) throw new Error('invoice.update matchResult 无效');
    if (update.approvalStatus !== undefined && !INVOICE_APPROVAL_STATUSES.has(update.approvalStatus)) throw new Error('invoice.update approvalStatus 无效');
    if (update.payableStatus !== undefined && !INVOICE_PAYABLE_STATUSES.has(update.payableStatus)) throw new Error('invoice.update payableStatus 无效');
    if (update.holdReason !== undefined && (typeof update.holdReason !== 'string' || !update.holdReason.trim() || update.holdReason.length > 500)) {
      throw new Error('invoice.update holdReason 必须是 1 到 500 个字符');
    }
    if (update.payableStatus === 'hold' && update.holdReason === undefined) throw new Error('invoice.update 标记 hold 时必须提供 holdReason');
    const vals: Record<string, unknown> = {};
    if (update.matchResult !== undefined) vals[INVOICE_MATCH_FIELDS.matchResult] = update.matchResult;
    if (update.approvalStatus !== undefined) vals[INVOICE_MATCH_FIELDS.approvalStatus] = update.approvalStatus;
    if (update.payableStatus !== undefined) vals[INVOICE_MATCH_FIELDS.payableStatus] = update.payableStatus;
    if (update.holdReason !== undefined) vals[INVOICE_MATCH_FIELDS.holdReason] = update.holdReason;
    if (Object.keys(vals).length === 0) throw new Error('invoice.update 至少需要一个三单匹配白名单字段');
    await this.call('account.move', 'write', { ids: [invoiceId], vals });
    const after = await this.readVendorInvoice(invoiceId);
    if (!after) throw new Error(`invoice.update 写入后无法重新读取发票 ${invoiceId}`);
    // Odoo may expose custom fields only when explicitly requested; ask for them below for verification.
    if (!await this.verifyInvoiceMatch(invoiceId, update)) throw new Error('invoice.update 写入核验不一致');
    return after;
  }

  /** 仅用于中断恢复的只读核验；调用方不得据此盲目重放写入。 */
  async verifyInvoiceMatch(invoiceId: number, update: OdooInvoiceMatchUpdate): Promise<boolean> {
    const verified = await this.searchRead('account.move', [['id', '=', invoiceId]], ['id', ...Object.values(INVOICE_MATCH_FIELDS)], 20);
    const row = verified[0];
    return Object.entries(INVOICE_MATCH_FIELDS).every(([key, field]) => update[key as keyof OdooInvoiceMatchUpdate] === undefined || row?.[field] === update[key as keyof OdooInvoiceMatchUpdate]);
  }

  updateInvoice(invoiceId: number, update: OdooInvoiceMatchUpdate): Promise<OdooVendorInvoice> { return this.updateInvoiceMatch(invoiceId, update); }

  private async partnerEmail(partnerId: number): Promise<string> {
    if (!partnerId) return '';
    const partners = (await this.call('res.partner', 'search_read', {
      domain: [['id', '=', partnerId]],
      fields: ['email'],
      limit: 1,
    })) as Array<Record<string, unknown>>;
    return String(partners[0]?.email ?? '');
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      const data = (await this.call('res.partner', 'search_read', {
        domain: [['is_company', '=', true]],
        fields: ['name'],
        limit: 1,
      })) as unknown[];
      return { ok: true, detail: `已连接 Odoo（${this.config.database}），供应商 ${data.length} 条可见` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

function normalizeEta(eta: string): string {
  const d = eta.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d} 00:00:00`;
  const timestamp = Date.parse(d);
  if (!Number.isFinite(timestamp)) throw new Error('Odoo 承诺交期不是有效日期');
  return new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19);
}

type NormalizedPurchaseOrderDraftInput = Omit<OdooPurchaseOrderDraftInput, 'partnerId' | 'currencyCode' | 'correlationKey' | 'lines'> & {
  correlationKey: string;
  partnerId: number;
  currencyCode: string;
  lines: Array<OdooPurchaseOrderDraftLineInput & { itemCode: string }>;
};

function normalizePurchaseOrderDraftInput(input: OdooPurchaseOrderDraftInput): NormalizedPurchaseOrderDraftInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('purchase-order draft 必须提供输入对象');
  const correlationKey = typeof input.correlationKey === 'string' ? input.correlationKey.trim() : '';
  if (!correlationKey || correlationKey.length > 180) throw new Error('purchase-order draft correlationKey 必须为 1 到 180 个字符');
  const partnerText = String(input.partnerId ?? '').trim().replace(/^odoo-/i, '');
  if (!/^\d+$/.test(partnerText)) throw new Error('purchase-order draft partnerId 必须是正整数');
  const partnerId = Number(partnerText);
  if (!Number.isSafeInteger(partnerId) || partnerId <= 0) throw new Error('purchase-order draft partnerId 必须是正整数');
  const currencyCode = typeof input.currencyCode === 'string' ? input.currencyCode.trim().toUpperCase() : '';
  if (!/^[A-Z]{3,10}$/.test(currencyCode)) throw new Error('purchase-order draft currencyCode 无效');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error('purchase-order draft 至少需要一行');
  const lines = input.lines.map((line, index) => {
    const itemCode = typeof line?.itemCode === 'string' ? line.itemCode.trim() : '';
    if (!itemCode) throw new Error(`purchase-order draft 第 ${index + 1} 行 itemCode 不能为空`);
    if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new Error(`purchase-order draft 第 ${index + 1} 行 quantity 必须大于 0`);
    if (!Number.isFinite(line.priceUnit) || line.priceUnit < 0) throw new Error(`purchase-order draft 第 ${index + 1} 行 priceUnit 必须不小于 0`);
    if (line.description !== undefined && (typeof line.description !== 'string' || !line.description.trim())) throw new Error(`purchase-order draft 第 ${index + 1} 行 description 无效`);
    return { ...line, itemCode, ...(line.description ? { description: line.description.trim() } : {}) };
  });
  return { correlationKey, partnerId, currencyCode, lines };
}

/** Keep this format stable: it is the only create idempotency key persisted in Odoo. */
export function purchaseOrderDraftOrigin(correlationKey: string): string {
  const key = correlationKey.trim();
  // Upstream outbox correlation keys already use the readywork: namespace.
  // Keep those byte-for-byte so one logical key maps to one Odoo origin.
  return key.startsWith('readywork:') ? key : `readywork:${key}`;
}

function finiteNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function asMany2One(value: unknown): [number, string] {
  return Array.isArray(value) ? [finiteNumber(value[0]), String(value[1] ?? '')] : [0, ''];
}

function asIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => Array.isArray(item) ? item[0] : item).map(Number).filter(Number.isFinite);
}

function asOptionalId(value: unknown): number | undefined {
  const id = asMany2One(value)[0] || (typeof value === 'number' ? value : 0);
  return id > 0 ? id : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function redactOdooError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/bearer\s+[^\s]+/gi, 'bearer [REDACTED]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s/]+\/json\/2/gi, '[ODOO]/json/2')
    .slice(0, 500);
}

import type { ErpAdapter } from '@readywork/core';

/** Odoo 的 ErpAdapter 实现 —— 把 OdooErpClient 包装成标准 ERP 端口，业务层零绑定 */
export class OdooErpAdapter implements ErpAdapter {
  constructor(private client: OdooErpClient) {}

  readPurchaseOrder(poNumber: string) { return this.client.readPO(poNumber); }
  listPurchaseOrders() { return this.client.listPOs(); }
  updatePurchaseOrderETA(poNumber: string, eta: string) { return this.client.updateETA(poNumber, eta); }
  listReceipts() { return this.client.listReceipts(); }
  listVendorBills() { return this.client.listVendorBills(); }
  healthCheck() { return this.client.healthCheck(); }
}
