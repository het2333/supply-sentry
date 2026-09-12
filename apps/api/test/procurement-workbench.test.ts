import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  Activity,
  Award,
  ApprovalRequest,
  Communication,
  Exception as BusinessException,
  ProcurementRequisition,
  ProductionProgress,
  ProductionProgressLine,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderConfirmation,
  QuoteComparisonSnapshot,
  RequisitionLine,
  Receipt,
  RequestForQuotation,
  Shipment,
  TransportEvent,
  Supplier,
  SupplierInvoice,
  SupplierQuote,
  Task,
  ThreeWayMatch,
} from '@readywork/core';
import { openPersistence, type PersistenceStore } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleProcurementWorkbenchRequest } from '../src/procurement-workbench.js';

const at = '2026-08-21T00:00:00.000Z';
const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';

function signSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', sessionSecret).update(payload).digest('base64url')}`;
}

function token(tenantId: string, role = '采购专员'): string {
  return signSession({ username: `buyer:${tenantId}`, tenantId, humanId: `human:${tenantId}`, name: tenantId, role, expiresAt: Date.now() + 60_000 });
}

function seedTenant(store: PersistenceStore, suffix: string): void {
  const tenantId = store.tenantId;
  const supplier: Supplier = {
    id: `supplier:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: `SUP-${suffix}`, status: 'active',
    createdAt: at, updatedAt: at, name: `供应商 ${suffix}`, currency: 'CNY',
    contacts: [{ id: `contact:${suffix}`, name: `联系人 ${suffix}`, primary: true }], performanceScore: 90,
  };
  const requisition: ProcurementRequisition = {
    id: `requisition:${suffix}`, tenantId, sourceSystem: 'manual', externalId: `REQ-${suffix}`, status: 'submitted',
    createdAt: at, updatedAt: at, source: 'manual', requesterId: `human:${suffix}`, requestedAt: at,
    title: `申请 ${suffix}`, currency: 'CNY',
  };
  const rfq: RequestForQuotation = {
    id: `rfq:${suffix}`, tenantId, sourceSystem: 'manual', externalId: `RFQ-${suffix}`, status: 'open',
    createdAt: at, updatedAt: at, requisitionId: requisition.id, buyerId: `human:${suffix}`,
    supplierIds: [`supplier:${suffix}`], currency: 'CNY', quoteDueAt: '2026-09-30T00:00:00.000Z', title: `询价 ${suffix}`,
    comparisonSnapshotId: `comparison:${suffix}`,
  };
  const po: PurchaseOrder = {
    id: `po:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: `PO-${suffix}`, status: 'sent',
    createdAt: at, updatedAt: at, awardId: `award:${suffix}`, supplierId: `supplier:${suffix}`, currency: 'CNY', orderedAt: at,
  };
  const invoice: SupplierInvoice = {
    id: `invoice:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: suffix === 'a' ? 'token=invoice-secret' : `INV-EXT-${suffix}`,
    status: 'received', createdAt: at, updatedAt: at, supplierId: `supplier:${suffix}`,
    invoiceNumber: `INV-${suffix}`, currency: 'CNY', invoiceDate: at,
  };
  const quote: SupplierQuote = {
    id: `quote:${suffix}`, tenantId, sourceSystem: 'manual', externalId: `QUOTE-${suffix}`, status: 'received',
    createdAt: at, updatedAt: at, rfqId: rfq.id, supplierId: supplier.id, currency: 'CNY', receivedAt: at,
    evidence: { attachmentIds: [`attachment:${suffix}:quote-evidence`], sourceChannel: 'email' },
  };
  const award: Award = {
    id: `award:${suffix}`, tenantId, sourceSystem: 'manual', externalId: `AWARD-${suffix}`, status: 'approved',
    createdAt: at, updatedAt: at, rfqId: rfq.id, approvedBy: `human:${suffix}`, approvedAt: at,
  };
  const comparison: QuoteComparisonSnapshot = {
    id: `comparison:${suffix}`, tenantId, sourceSystem: 'readywork', externalId: `COMPARISON-${suffix}`, status: 'final',
    createdAt: at, updatedAt: at, rfqId: rfq.id, rfqVersion: 1, createdBy: `human:${suffix}`, asOf: at,
    comparisonCurrency: 'CNY', rateSnapshot: { version: 'rates:1', rates: { CNY: 1 } },
    weights: { price: 1, leadTime: 0, paymentTerms: 0, performance: 0 }, ruleVersion: 'rule:1', lineComparisons: [],
  };
  const requisitionLine: RequisitionLine = {
    id: `requisition-line:${suffix}`, requisitionId: requisition.id, lineNumber: '10', itemId: `item:${suffix}`,
    uom: 'EA', requestedQty: 10, requiredAt: at,
    attachmentIds: [`attachment:${suffix}:spec`, `attachment:${suffix}:legacy`],
    attachments: [{
      id: `attachment:${suffix}:spec`, fileName: `spec-${suffix}.pdf`, contentType: 'application/pdf', sizeBytes: 2048,
      url: `https://files.example.test/${suffix}/spec.pdf`,
    }],
  };
  const confirmation: PurchaseOrderConfirmation = {
    id: `confirmation:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: `CONF-${suffix}`, status: 'confirmed',
    createdAt: at, updatedAt: at, poId: po.id, supplierId: supplier.id, confirmedAt: at, supplierReference: `REF-${suffix}`,
  };
  const shipment: Shipment = {
    id: `shipment:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: `SHIP-${suffix}`, status: 'shipped',
    createdAt: at, updatedAt: at, poId: po.id, supplierId: supplier.id, shippedAt: at,
    carrier: 'DHL', trackingNumber: `TRACK-${suffix}`, estimatedArrivalAt: '2026-08-25T08:30:00.000Z',
  };
  const receipt: Receipt = {
    id: `receipt:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: `RCPT-${suffix}`, status: 'received',
    createdAt: at, updatedAt: at, poId: po.id, shipmentId: shipment.id, warehouseId: `warehouse:${suffix}`, receivedAt: at,
  };
  const transportEvent: TransportEvent = {
    id: `transport-event:${suffix}`, tenantId, sourceSystem: 'readywork-manual-verification', externalId: `TRACK-EVT-${suffix}`, status: 'recorded',
    createdAt: '2026-08-22T08:00:00.000Z', updatedAt: '2026-08-22T08:00:00.000Z', poId: po.id, shipmentId: shipment.id,
    eventCode: 'arrived_port', occurredAt: '2026-08-22T07:30:00.000Z', location: '上海港', estimatedArrivalAt: '2026-09-05T08:00:00.000Z',
    carrierReference: `CARRIER-EVT-${suffix}`, evidenceSource: 'manual_verified', evidenceReference: `carrier:evidence:${suffix}`,
    verifiedBy: `human:${suffix}`, verificationReason: '已核对承运商轨迹页面',
  };
  const match: ThreeWayMatch = {
    id: `match:${suffix}`, tenantId, sourceSystem: 'readywork', externalId: `MATCH-${suffix}`, status: 'matched',
    createdAt: at, updatedAt: at, poId: po.id, invoiceId: invoice.id, result: 'exact_match',
  };
  const communication: Communication = {
    id: `communication:${suffix}`, tenantId, sourceSystem: 'email', externalId: `COMM-${suffix}`, status: 'received',
    createdAt: at, updatedAt: at, businessObjectId: po.id, businessObjectType: 'purchase_order', supplierId: supplier.id,
    channel: 'email', direction: 'inbound', provider: 'imap', mailbox: 'purchasing@example.com/INBOX', uid: `uid:${suffix}`,
    messageId: `message:${suffix}`, from: `supplier-${suffix}@example.com`, subject: `确认 ${suffix}`,
    body: suffix === 'a' ? 'token=communication-body-secret' : '确认内容', attachmentIds: [], occurredAt: at, receivedAt: at,
  };
  store.procurement.saveDocument('supplier', supplier);
  store.procurement.saveDocument('supplier', {
    ...supplier,
    id: `supplier:${suffix}:secondary`,
    externalId: `SUP-${suffix}-SECONDARY`,
    name: `备用供应商 ${suffix}`,
    contacts: [],
  });
  store.procurement.saveDocument('requisition', requisition);
  store.procurement.saveLine('requisition_line', requisition.id, requisitionLine);
  store.procurement.saveDocument('rfq', rfq);
  store.procurement.saveDocument('quote', quote);
  store.procurement.saveDocument('award', award);
  store.procurement.saveDocument('purchase_order', po);
  const poLine: PurchaseOrderLine = {
    id: `po-line:${suffix}`, poId: po.id, lineNumber: '10', itemId: `item:${suffix}`,
    description: `测试物料 ${suffix}`, uom: 'EA', orderedQty: 10, unitPrice: 20, currency: 'CNY', requestedAt: at,
  };
  store.procurement.saveLine('purchase_order_line', po.id, poLine);
  const productionProgress: ProductionProgress = {
    id: `production-progress:${suffix}`, tenantId, sourceSystem: 'readywork-manual-verification', externalId: `PROGRESS-${suffix}`,
    status: 'recorded', createdAt: '2026-08-22T05:00:00.000Z', updatedAt: '2026-08-22T05:00:00.000Z',
    poId: po.id, supplierId: supplier.id, reportedAt: '2026-08-22T05:00:00.000Z', overallStatus: 'delayed',
    evidenceSource: 'manual_verified', evidenceReference: `mail:production-progress:${suffix}`,
    verifiedBy: `human:${suffix}`, verificationReason: '已核对供应商生产进度邮件',
  };
  const productionProgressLine: ProductionProgressLine = {
    id: `production-progress-line:${suffix}`, progressId: productionProgress.id, poLineId: poLine.id,
    lineNumber: poLine.lineNumber, itemId: poLine.itemId, description: poLine.description, uom: poLine.uom,
    progressStatus: 'delayed', completionPercent: 40, completedQty: 4,
    expectedReadyAt: '2026-08-23T00:00:00.000Z', note: '关键原料晚到两天',
  };
  store.procurement.saveDocument('production_progress', productionProgress);
  store.procurement.saveLine('production_progress_line', productionProgress.id, productionProgressLine);
  const projection = {
    poLineId: poLine.id, orderedQty: 10, confirmedQty: 0, shippedQty: 0,
    receivedQty: 0, invoicedQty: 0, cancelledQty: 0,
  };
  store.db.prepare(`INSERT INTO procurement_po_line_quantity_projections
    (tenant_id,po_line_id,ordered_qty,confirmed_qty,shipped_qty,received_qty,invoiced_qty,cancelled_qty,projection_json,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(tenantId, poLine.id, 10, 0, 0, 0, 0, 0, JSON.stringify(projection), at);
  store.procurement.saveDocument('confirmation', confirmation);
  store.procurement.saveDocument('shipment', shipment);
  store.procurement.saveDocument('transport_event', transportEvent);
  store.procurement.saveDocument('receipt', receipt);
  store.procurement.saveDocument('invoice', invoice);
  store.procurement.saveDocument('match', match);
  store.procurement.saveDocument('communication', communication);
  const cleanAttachment = Buffer.from(`PO ${suffix} 已扫描附件`, 'utf8');
  const pendingAttachment = Buffer.from(`PO ${suffix} 待扫描附件`, 'utf8');
  for (const attachment of [
    { id: `attachment:${suffix}:po-clean`, fileName: `po-${suffix}-clean.txt`, content: cleanAttachment, security: 'clean', processing: 'parsed' },
    { id: `attachment:${suffix}:po-pending`, fileName: `po-${suffix}-pending.txt`, content: pendingAttachment, security: 'pending_scan', processing: 'queued' },
  ]) {
    store.db.prepare(`INSERT INTO procurement_attachments
      (tenant_id,id,requisition_id,requisition_line_id,owner_type,owner_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,
       extraction_status,extracted_text_preview,content,status,security_status,processing_status,detected_content_type,storage_backend,created_by,created_at)
      VALUES (?,?,?,NULL,'purchase_order',?,?, 'text/plain',?,?,1,NULL,'text_extracted',?,?, 'active',?,?, 'text/plain','sqlite','test:seed',?)`)
      .run(tenantId, attachment.id, po.id, po.id, attachment.fileName, attachment.content.length,
        createHash('sha256').update(attachment.content).digest('hex'), attachment.content.toString('utf8'), attachment.content,
        attachment.security, attachment.processing, at);
  }
  store.db.prepare(`INSERT INTO procurement_documents
    (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
    VALUES (?,'quote_comparison',?,?,?,?,1,?,?,?)`)
    .run(tenantId, comparison.id, comparison.sourceSystem, comparison.externalId, comparison.status,
      JSON.stringify(comparison), comparison.createdAt, comparison.updatedAt);

  const task: Task = {
    id: `task:${suffix}`, tenantId, employeeId: 'ai:procurement', workflowId: 'procurement-workflow',
    businessObjectId: po.id, status: 'running', attempts: 1, maxRetries: 3,
    checkpoint: { stepIndex: 1, waitingReason: '等待处理', workspace: {} }, createdAt: at,
    error: suffix === 'a' ? 'apiKey=task-secret' : undefined, metadata: {},
  };
  store.tasks.save(task);
  store.tasks.save({ ...task, id: `task:${suffix}:done`, status: 'completed', completedAt: at, error: undefined });
  const approval: ApprovalRequest = {
    id: `approval:${suffix}`, taskId: task.id, ruleId: 'rule:1', title: '采购审批', message: '请确认',
    payload: suffix === 'a' ? { token: 'approval-secret' } : {}, status: 'pending', requestedAt: at,
  };
  store.approvals.save(approval);
  const exception: BusinessException = {
    id: `exception:${suffix}`, type: 'price_variance', severity: 'high', objectId: po.id, objectType: 'purchase_order',
    aiJudgment: '价格异常', recommendedAction: suffix === 'a' ? 'password=exception-secret' : '人工核对',
    context: {}, needsApproval: true, approvalId: approval.id, status: 'open', createdAt: at,
  };
  store.exceptions.save(exception);
  const activity: Activity = {
    id: `activity:${suffix}`, at, objectId: po.id, actor: 'ai:procurement', action: 'po.reviewed', summary: '已复核采购单',
    context: suffix === 'a' ? { apiKey: 'activity-secret' } : {},
  };
  store.activities.append(activity);
  const executionApproval = {
    id: `procurement-approval:${suffix}`, tenantId, kind: 'supplier_confirmation', objectId: confirmation.id,
    poId: po.id, status: 'pending', requestedBy: `human:${suffix}`, requestedAt: at,
    reason: '供应商确认存在差异',
  };
  store.db.prepare(`INSERT INTO procurement_execution_approvals
    (tenant_id,id,kind,object_id,status,json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(tenantId, executionApproval.id, executionApproval.kind, executionApproval.objectId,
      executionApproval.status, JSON.stringify(executionApproval), at, at);
  const outbox = {
    id: `outbox:${suffix}`, tenantId, channel: 'email', connectorId: 'email', action: 'purchase_order.followup',
    aggregateId: po.id, idempotencyKey: `outbox-key:${suffix}`, status: 'failed', payload: { body: 'private email body' },
    attempt: 3, createdAt: at, updatedAt: at, failedAt: at,
    error: suffix === 'a' ? 'password=outbox-error-secret' : '连接失败',
  };
  store.db.prepare(`INSERT INTO procurement_outbox
    (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,created_at,updated_at,
      attempt,failed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(tenantId, outbox.id, outbox.channel, outbox.connectorId, outbox.action, outbox.aggregateId,
      outbox.idempotencyKey, outbox.status, JSON.stringify(outbox.payload), JSON.stringify(outbox), at, at, 3, at);
  store.db.prepare(`INSERT INTO procurement_supplier_operating_profiles
    (tenant_id,supplier_id,version,country_code,route,supplier_type,industry,address_json,primary_material_code,primary_material_name,
     default_lead_time_days,product_criticality,payment_terms,contract_starts_on,contract_ends_on,status,created_at,updated_at)
    VALUES (?,?,1,'CN','local','manufacturer','工业自动化',?,'PV','气动阀',14,'high','NET30','2026-01-01','2026-12-31','active',?,?)`)
    .run(tenantId, supplier.id, JSON.stringify({ line1: '工业园区 1 号', line2: null, city: '苏州', region: null, postalCode: null, countryCode: 'CN' }), at, at);
  store.db.prepare(`INSERT INTO procurement_purchase_order_amendments
    (tenant_id,id,po_id,action,source_po_version,normalized_patch_json,state,outbox_id,receipt_reference,idempotency_key,actor_id,reason,created_at,updated_at,applied_at)
    VALUES (?,?,?,'edit',1,?,'requested',NULL,NULL,?,?,?,?,?,NULL)`)
    .run(tenantId, `po-amendment:${suffix}`, po.id, JSON.stringify({ requiredInHouseAt: '2026-09-30' }), `amendment-key:${suffix}`, `human:${suffix}`, '调整到货日', at, at);
  if (suffix === 'a') {
    store.db.prepare(`INSERT INTO procurement_purchase_order_amendments
      (tenant_id,id,po_id,action,source_po_version,normalized_patch_json,state,outbox_id,receipt_reference,idempotency_key,actor_id,reason,created_at,updated_at,applied_at)
      VALUES (?,?,?,'cancel',1,?,'unknown',?,NULL,?,?,?,?,?,NULL)`)
      .run(tenantId, 'po-cancellation:a', po.id, JSON.stringify({ status: 'cancelled' }), 'outbox:cancel:a', 'cancel-key:a', 'human:a', '项目取消已批准', at, at);
  }
  store.db.prepare(`INSERT INTO procurement_purchase_order_document_snapshots
    (tenant_id,id,po_id,document_id,snapshot_kind,source_po_version,context_watermark,template_version,content_sha256,object_key,size_bytes,generated_by,generated_at)
    VALUES (?,?,?,?,'purchase_order',1,?,1,?,?,1024,?,?)`)
    .run(tenantId, `po-snapshot:${suffix}`, po.id, `po-document:${suffix}`, at,
      createHash('sha256').update(`po-document:${suffix}`).digest('hex'), `po/${suffix}.pdf`, `human:${suffix}`, at);
}

test('采购工作台 API: SQLite 真实聚合、租户隔离、权限、稳定并发读取与脱敏', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-procurement-workbench-'));
  const dbPath = join(dir, 'test.db');
  const store = openPersistence(dbPath, { tenantId: 'tenant:a' });
  seedTenant(store, 'a');
  const visualException = {
    id: 'visual-test:exception:a', type: 'price_variance', severity: 'high', objectId: 'po:a', objectType: 'purchase_order',
    aiJudgment: '视觉验收记录不得进入 V1', recommendedAction: '不执行', context: { visualTest: true },
    needsApproval: false, status: 'open', createdAt: '2026-08-21T00:00:00.000Z',
  };
  store.exceptions.save(visualException as BusinessException);
  store.activities.append({
    id: 'visual-test:activity:a', at: '2026-08-21T00:00:00.000Z', objectId: 'po:a', actor: 'visual-test',
    action: 'visual.acceptance_created', summary: '视觉验收活动不得进入 V1', context: {},
  });
  const tenantBStore = openPersistence(dbPath, { tenantId: 'tenant:b' });
  seedTenant(tenantBStore, 'b');
  tenantBStore.close();
  let activeDb: DatabaseSync = store.db;
  let emailConnectorReady = false;
  let erpConnectorReady = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers['authorization'];
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleProcurementWorkbenchRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: activeDb,
      session: resolveSession(bearer),
      now: () => new Date('2026-08-22T00:00:00.000Z'),
      connectorReady: (connectorId) => connectorId === 'email' ? emailConnectorReady : connectorId === 'erp' && erpConnectorReady,
    })
      .then((handled) => { if (!handled) res.writeHead(404).end(); })
      .catch((error: unknown) => { res.writeHead(500).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function request(path: string, options: { method?: string; token?: string } = {}): Promise<{ status: number; body: Record<string, any> }> {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  try {
    await t.test('要求 read 权限且只允许 GET', async () => {
      assert.equal((await request('/api/procurement/workbench')).status, 401);
      assert.equal((await request('/api/procurement/workbench', { token: token('tenant:a', '访客') })).status, 403);
      assert.equal((await request('/api/procurement/workbench', { method: 'POST', token: token('tenant:a') })).status, 405);
      const invalidLimit = await request('/api/procurement/workbench?limit=', { token: token('tenant:a') });
      assert.equal(invalidLimit.status, 400);
      assert.equal(invalidLimit.body['code'], 'INVALID_WORKBENCH_LIMIT');
      const invalidContextId = await request('/api/procurement/workbench/context/%E0%A4%A', { token: token('tenant:a') });
      assert.equal(invalidContextId.status, 400);
      assert.equal(invalidContextId.body['code'], 'INVALID_CONTEXT_ID');
    });

    await t.test('聚合 Didero 采购域单据和真实待办、审批、异常、活动', async () => {
      const response = await request('/api/procurement/workbench', { token: token('tenant:a') });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body['counts'], {
        items: 1, contacts: 1, suppliers: 2, requisitions: 1, rfqs: 1, quotes: 1, awards: 1,
        purchaseOrders: 1, confirmations: 1, productionProgress: 1, shipments: 1, receipts: 1, invoices: 1,
        matches: 1, communications: 1, inbox: 1, alerts: 1,
        pendingTasks: 1, pendingApprovals: 1, openExceptions: 1,
      });
      assert.equal(response.body['documents']['items']['total'], 0);
      assert.equal(response.body['documents']['suppliers']['total'], 2);
      assert.ok(response.body['documents']['suppliers']['items'].some((item: Record<string, unknown>) => item['id'] === 'supplier:a'));
      assert.equal(response.body['documents']['requisitions']['items'][0].id, 'requisition:a');
      assert.equal(response.body['documents']['rfqs']['items'][0].supplierCount, 1);
      assert.equal(response.body['documents']['quotes']['items'][0].rfqId, 'rfq:a');
      assert.equal(response.body['documents']['awards']['items'][0].rfqId, 'rfq:a');
      assert.equal(response.body['documents']['purchaseOrders']['items'][0].id, 'po:a');
      assert.equal(response.body['documents']['purchaseOrders']['items'][0].number, null);
      assert.equal(response.body['documents']['purchaseOrders']['items'][0].displayNumber, 'PO-a');
      assert.equal(response.body['documents']['purchaseOrders']['items'][0].supplierName, '供应商 a');
      assert.equal(response.body['documents']['confirmations']['items'][0].poId, 'po:a');
      assert.equal(response.body['documents']['productionProgress']['items'][0].poId, 'po:a');
      assert.equal(response.body['documents']['productionProgress']['items'][0].overallStatus, 'delayed');
      assert.equal(response.body['documents']['productionProgress']['items'][0].evidenceSource, 'manual_verified');
      assert.equal(response.body['documents']['shipments']['items'][0].poId, 'po:a');
      assert.equal(response.body['documents']['shipments']['items'][0].estimatedArrivalAt, '2026-08-25T08:30:00.000Z');
      assert.equal(response.body['documents']['receipts']['items'][0].shipmentId, 'shipment:a');
      assert.equal(response.body['documents']['invoices']['items'][0].id, 'invoice:a');
      assert.equal(response.body['documents']['matches']['items'][0].result, 'exact_match');
      assert.equal(response.body['documents']['communications']['items'][0].messageId, 'message:a');
      assert.equal(response.body['documents']['communications']['items'][0].from, 'supplier-a@example.com');
      assert.equal(response.body['documents']['communications']['items'][0].receivedAt, at);
      assert.equal('body' in response.body['documents']['communications']['items'][0], false, '通讯正文不进入聚合摘要');
      assert.equal(response.body['tasks']['total'], 2);
      assert.equal(response.body['tasks']['items'].length, 1);
      assert.equal(response.body['approvals']['items'][0].id, 'approval:a');
      assert.equal(response.body['executionApprovals']['items'][0].id, 'procurement-approval:a');
      assert.equal(response.body['executionApprovals']['items'][0].poId, 'po:a');
      assert.deepEqual(response.body['permissions'], { operate: true, approve: false, configure: false });
      assert.equal(response.body['exceptions']['items'][0].id, 'exception:a');
      assert.equal(response.body['recentActivities']['items'][0].id, 'activity:a');
      assert.deepEqual(response.body['operations'], {
        tracked: 3,
        running: 1,
        waitingExternal: 1,
        waitingAction: 1,
        exceptions: 2,
        completedLast7Days: 1,
        byStatus: {
          tasks: { completed: 1, running: 1 },
          purchaseOrders: { sent: 1 },
          approvals: { pending: 1 },
          exceptions: { open: 1 },
          outbox: { failed: 1 },
        },
      });
      assert.equal(response.body['portfolio']['metrics']['activePurchaseOrders'], 1);
      assert.equal(response.body['portfolio']['metrics']['highRisk'], 0);
      assert.equal(response.body['portfolio']['metrics']['unclassifiedRoute'], 1);
      assert.equal(response.body['portfolio']['items'][0]['number'], 'PO-a');
      assert.equal(response.body['portfolio']['items'][0]['stage'], 'supplier_commitment');
      assert.equal(response.body['portfolio']['items'][0]['supplierName'], '供应商 a');
      assert.equal(response.body['portfolio']['items'][0]['risk'], 'medium');
      assert.equal(response.body['portfolio']['items'][0]['riskScore'], 67);
      assert.equal(response.body['portfolio']['items'][0]['riskPublicationState'], 'published');
      assert.equal(response.body['portfolio']['items'][0]['riskModel']['evidenceCoverage'], 1);
      assert.equal(response.body['portfolio']['items'][0]['riskModel']['totalScore'], 67);
      assert.deepEqual(Object.fromEntries(Object.entries(response.body['portfolio']['items'][0]['riskModel']['components'])
        .map(([name, component]) => [name, (component as Record<string, unknown>)['score']])), {
        supplierPerformance: 10,
        deliveryDelay: 82,
        poValue: 100,
        productCriticality: 100,
        complianceApproval: 88,
      });
      assert.equal(response.body['portfolio']['items'][0]['productionProgressCount'], 1);
      assert.equal(response.body['portfolio']['items'][0]['latestProductionProgress']['externalId'], 'PROGRESS-a');
      assert.equal(response.body['portfolio']['items'][0]['latestProductionProgress']['overallStatus'], 'delayed');
      assert.equal(response.body['portfolio']['items'][0]['shipmentCount'], 1);
      assert.equal(response.body['portfolio']['items'][0]['transportEventCount'], 1);
      assert.equal(response.body['portfolio']['items'][0]['receiptCount'], 1);
      assert.equal(response.body['portfolio']['items'][0]['latestShipment']['trackingNumber'], 'TRACK-a');
      assert.equal(response.body['portfolio']['items'][0]['latestShipment']['estimatedArrivalAt'], '2026-09-05T08:00:00.000Z');
      assert.equal(response.body['portfolio']['items'][0]['latestTransportEvent']['eventCode'], 'arrived_port');
      assert.equal(response.body['portfolio']['items'][0]['latestTransportEvent']['location'], '上海港');
      assert.equal(response.body['portfolio']['items'][0]['latestReceipt']['externalId'], 'RCPT-a');
      assert.ok(response.body['portfolio']['items'][0]['riskFactors'].some((factor: Record<string, unknown>) => factor['code'] === 'connector_failed'));
      assert.ok(response.body['portfolio']['items'][0]['riskFactors'].some((factor: Record<string, unknown>) => factor['code'] === 'production_delayed'));
      assert.deepEqual(response.body['views']['contacts']['items'][0], {
        id: 'contact:a', name: '联系人 a', supplierId: 'supplier:a', supplierName: '供应商 a',
        role: null, email: null, phone: null, primary: true, status: 'active', updatedAt: at,
      });
      assert.equal(response.body['views']['items']['items'][0].id, 'item:a');
      assert.equal(response.body['views']['items']['items'][0].sourceDocumentId, 'requisition:a');
      assert.equal(response.body['views']['inbox']['items'][0].id, 'communication:a');
      assert.equal(response.body['views']['alerts']['items'][0].id, 'exception:a');
      assert.deepEqual(response.body['views']['news'], {
        total: 0, items: [], status: 'unconfigured', message: '尚未配置可信供应链资讯源',
      });
      const serialized = JSON.stringify(response.body);
      assert.equal(serialized.includes('视觉验收记录不得进入 V1'), false);
      assert.equal(serialized.includes('视觉验收活动不得进入 V1'), false);
      for (const secret of ['invoice-secret', 'task-secret', 'approval-secret', 'exception-secret', 'activity-secret', 'communication-body-secret', 'outbox-error-secret', 'private email body']) {
        assert.equal(serialized.includes(secret), false);
      }
    });

    await t.test('供应商邮件路线来源在组合读模型中保持 supplier_email_ai', async () => {
      const evidence = { sourceType: 'supplier_email_ai', communicationId: 'communication:a', quote: '本订单为境内采购', model: 'deepseek-v4-flash', purchaseOrderVersion: 1 };
      store.db.prepare(`INSERT INTO procurement_route_assignments
        (tenant_id,po_id,route,source,evidence_json,version,created_by,updated_by,created_at,updated_at)
        VALUES ('tenant:a','po:a','local','supplier_email_ai',?,1,'ai:supplier-reply','ai:supplier-reply',?,?)`)
        .run(JSON.stringify(evidence), at, at);
      try {
        const response = await request('/api/procurement/workbench', { token: token('tenant:a') });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const item = response.body['portfolio']['items'].find((entry: Record<string, unknown>) => entry['id'] === 'po:a');
        assert.equal(item['route'], 'local');
        assert.equal(item['routeSource'], 'supplier_email_ai');
        assert.equal(item['routeEvidence']['communicationId'], 'communication:a');
      } finally {
        store.db.prepare("DELETE FROM procurement_route_assignments WHERE tenant_id='tenant:a' AND po_id='po:a'").run();
      }
    });

    await t.test('重复和并发 GET 返回相同快照且不产生新数据', async () => {
      const [first, second] = await Promise.all([
        request('/api/procurement/workbench?limit=1', { token: token('tenant:a') }),
        request('/api/procurement/workbench?limit=1', { token: token('tenant:a') }),
      ]);
      assert.equal(first.status, 200);
      assert.deepEqual(second.body, first.body);
      assert.equal(first.body['documents']['suppliers']['total'], 2);
      assert.equal(first.body['documents']['suppliers']['items'].length, 1);
      const replay = await request('/api/procurement/workbench?limit=1', { token: token('tenant:a') });
      assert.deepEqual(replay.body, first.body);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM runtime_activities WHERE tenant_id=?').get('tenant:a')?.['count'], 2);
    });

    await t.test('Odoo draft 处于 PO 发出阶段，但不冒充已发送事实', async () => {
      const identityBlockedFollowup = await request(`/api/procurement/workbench/context/${encodeURIComponent('po:a')}`, { token: token('tenant:a') });
      assert.ok(identityBlockedFollowup.body['suppliers'].some((supplier: Record<string, unknown>) => supplier['id'] === 'supplier:a:secondary'), 'Edit PO receives active same-tenant suppliers beyond current PO references');
      assert.equal(identityBlockedFollowup.body['suppliers'].some((supplier: Record<string, unknown>) => supplier['id'] === 'supplier:b'), false, 'Edit PO supplier options never cross tenant boundary');
      assert.deepEqual(identityBlockedFollowup.body['actionReadiness']['queue_followup'], {
        ready: false,
        code: 'communication_identity_missing',
        message: '尚未配置供应商可见的采购专业联系人，不能生成可外发跟进草稿。',
        target: 'communication-identity',
      });
      assert.deepEqual(identityBlockedFollowup.body['actionReadiness']['update_rihd'], {
        ready: false,
        code: 'odoo_mapping_missing',
        message: '当前 PO 没有可回写的 Odoo 单号映射。',
      });
      const draftPo: PurchaseOrder = {
        id: 'po:a:odoo-draft', tenantId: 'tenant:a', sourceSystem: 'odoo', externalId: 'P00022', status: 'draft',
        createdAt: at, updatedAt: at, supplierId: 'supplier:a', currency: 'CNY', orderedAt: at,
      };
      store.procurement.saveDocument('purchase_order', draftPo);

      const response = await request('/api/procurement/workbench', { token: token('tenant:a') });
      assert.equal(response.status, 200);
      const portfolioPo = response.body['portfolio']['items'].find((item: Record<string, unknown>) => item['id'] === draftPo.id);
      assert.equal(portfolioPo['status'], 'draft');
      assert.equal(portfolioPo['stage'], 'po_sent');
      assert.equal(portfolioPo['stageLabel'], 'PO 发出');
      assert.equal(portfolioPo['nextAction'], '发送采购订单');

      const context = await request(`/api/procurement/workbench/context/${encodeURIComponent(draftPo.id)}`, { token: token('tenant:a') });
      assert.equal(context.status, 200);
      assert.deepEqual(context.body['stageTimeline'].map((stage: Record<string, unknown>) => [stage['id'], stage['state']]), [
        ['po_sent', 'active'],
        ['supplier_commitment', 'pending'],
        ['fulfilment_production', 'pending'],
        ['dispatch_transit', 'pending'],
        ['delivery_grn', 'pending'],
      ]);
      assert.deepEqual(context.body['actionReadiness']['send_po'], {
        ready: false,
        code: 'communication_identity_missing',
        message: '尚未配置供应商可见的采购专业联系人，不能发送采购订单。',
        target: 'communication-identity',
      });
      assert.deepEqual(context.body['actionReadiness']['duplicate_po'], {
        ready: false,
        code: 'po_lines_missing',
        message: '当前 PO 没有可复制的订单行。',
      });

      store.db.prepare(`INSERT INTO procurement_communication_identities
        (tenant_id,display_name,title,organization_name,status,version,created_by,updated_by,created_at,updated_at)
        VALUES (?,?,?,?, 'active',1,?,?,?,?)`).run(
        'tenant:a', '李娜', '高级采购专员', '东方制造有限公司', 'human:manager', 'human:manager', at, at,
      );
      const supplierEmailBlockedFollowup = await request(`/api/procurement/workbench/context/${encodeURIComponent('po:a')}`, { token: token('tenant:a') });
      assert.deepEqual(supplierEmailBlockedFollowup.body['actionReadiness']['queue_followup'], {
        ready: false,
        code: 'supplier_email_missing',
        message: '当前供应商没有可用的真实邮箱，不能生成可外发跟进草稿。',
      });
      const supplierA = store.procurement.getDocument<Supplier>('supplier', 'supplier:a')!;
      store.procurement.saveDocument('supplier', {
        ...supplierA.document,
        contacts: [{ id: 'contact:a', name: '联系人 a', primary: true, email: 'supplier@supplysentry.invalid' }],
        updatedAt: '2026-08-22T00:00:00.000Z',
      }, supplierA.version);
      const readyFollowup = await request(`/api/procurement/workbench/context/${encodeURIComponent('po:a')}`, { token: token('tenant:a') });
      assert.deepEqual(readyFollowup.body['actionReadiness']['queue_followup'], {
        ready: true,
        code: 'ready',
        message: '供应商跟进草稿前置条件已满足。',
      });
      assert.deepEqual(readyFollowup.body['actionReadiness']['duplicate_po'], {
        ready: true,
        code: 'ready',
        message: '将复制供应商、币种和订单行，并生成独立 Readywork PO Draft。',
      });
      const portfolioWithFollowup = await request('/api/procurement/workbench', { token: token('tenant:a') });
      const portfolioFollowupPo = portfolioWithFollowup.body['portfolio']['items']
        .find((item: Record<string, unknown>) => item['id'] === 'po:a');
      assert.equal(portfolioFollowupPo['version'], 1);
      assert.deepEqual(portfolioFollowupPo['actionReadiness']['queue_followup'], readyFollowup.body['actionReadiness']['queue_followup']);
      assert.deepEqual(portfolioFollowupPo['actionReadiness']['duplicate_po'], readyFollowup.body['actionReadiness']['duplicate_po']);
      const connectorBlocked = await request(`/api/procurement/workbench/context/${encodeURIComponent(draftPo.id)}`, { token: token('tenant:a') });
      assert.deepEqual(connectorBlocked.body['actionReadiness']['send_po'], {
        ready: false,
        code: 'email_connector_unavailable',
        message: '真实邮箱连接器尚未通过外部连通性验证，不能发送采购订单。',
        target: 'connector-email',
      });
      emailConnectorReady = true;
      const ready = await request(`/api/procurement/workbench/context/${encodeURIComponent(draftPo.id)}`, { token: token('tenant:a') });
      assert.deepEqual(ready.body['actionReadiness']['send_po'], {
        ready: true,
        code: 'ready',
        message: '发送前置条件已满足。',
      });

      const mappedPo = {
        id: 'po:a:rihd', tenantId: 'tenant:a', sourceSystem: 'odoo', externalId: 'purchase.order:44', status: 'confirmed',
        createdAt: at, updatedAt: at, supplierId: 'supplier:a', currency: 'CNY', orderedAt: at, number: 'P00044',
        requiredInHouseAt: '2026-09-10T00:00:00.000Z',
      } as PurchaseOrder & { number: string };
      const mappedLine: PurchaseOrderLine = { id: 'po-line:a:rihd', poId: mappedPo.id, lineNumber: '44', itemId: 'item:a', uom: 'EA', orderedQty: 10, unitPrice: 5, currency: 'CNY', requestedAt: '2026-09-10T00:00:00.000Z' };
      store.procurement.saveDocument('purchase_order', mappedPo); store.procurement.saveLine('purchase_order_line', mappedPo.id, mappedLine);
      const erpBlocked = await request(`/api/procurement/workbench/context/${encodeURIComponent(mappedPo.id)}`, { token: token('tenant:a') });
      assert.deepEqual(erpBlocked.body['actionReadiness']['update_rihd'], {
        ready: false,
        code: 'erp_connector_unavailable',
        message: 'Odoo 连接器未通过真实外部验证，不能修改 RIHD。',
        target: 'connector-erp',
      });
      erpConnectorReady = true;
      const rihdReady = await request(`/api/procurement/workbench/context/${encodeURIComponent(mappedPo.id)}`, { token: token('tenant:a') });
      assert.deepEqual(rihdReady.body['actionReadiness']['update_rihd'], {
        ready: true,
        code: 'ready',
        message: 'RIHD 写入与写后核验前置条件已满足。',
      });
      const portfolioWithRihd = await request('/api/procurement/workbench', { token: token('tenant:a') });
      assert.deepEqual(portfolioWithRihd.body['portfolio']['items'].find((item: Record<string, unknown>) => item['id'] === mappedPo.id)['actionReadiness']['update_rihd'], rihdReady.body['actionReadiness']['update_rihd']);
    });

    await t.test('PO 的供应商名称不受供应商列表分页影响', async () => {
      const laterPurchaseOrder: PurchaseOrder = {
        id: 'po:a:secondary-supplier', tenantId: 'tenant:a', sourceSystem: 'odoo', externalId: 'PO-A-SECONDARY',
        status: 'sent', createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z',
        supplierId: 'supplier:a:secondary', currency: 'CNY', orderedAt: '2026-08-22T00:00:00.000Z',
      };
      store.procurement.saveDocument('purchase_order', laterPurchaseOrder);
      const response = await request('/api/procurement/workbench?limit=1', { token: token('tenant:a') });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body['documents']['suppliers']['items'].length, 1);
      assert.equal(response.body['documents']['suppliers']['items'][0]['id'], 'supplier:a');
      assert.equal(response.body['documents']['purchaseOrders']['items'][0]['id'], laterPurchaseOrder.id);
      assert.equal(response.body['documents']['purchaseOrders']['items'][0]['supplierName'], '备用供应商 a');
    });

    await t.test('Mark at risk 的读取合同在 Portfolio 与 Context 中保持同源，并严格租户隔离', async () => {
      const before = await request('/api/procurement/workbench/context/po%3Aa', { token: token('tenant:a') });
      assert.equal(before.status, 200);
      assert.deepEqual(before.body['actionReadiness']['mark_at_risk'], {
        ready: true,
        code: 'ready',
        message: '可创建人工风险事实并进入统一异常与审计链。',
      });

      const beforePortfolio = await request('/api/procurement/workbench', { token: token('tenant:a') });
      assert.equal(beforePortfolio.status, 200);
      const beforePo = beforePortfolio.body['portfolio']['items'].find((item: Record<string, unknown>) => item['id'] === 'po:a');
      assert.deepEqual(beforePo['actionReadiness']['mark_at_risk'], before.body['actionReadiness']['mark_at_risk']);

      const markedAt = '2026-08-22T12:34:56.000Z';
      store.procurement.executeProcurementMutation({
        action: 'mark_at_risk',
        aggregateId: 'po:a',
        expectedVersion: 1,
        idempotencyKey: 'mark-at-risk:a',
        payloadHash: 'mark-at-risk:a:hash',
        actorId: 'human:risk-manager',
        permission: 'operate',
        occurredAt: markedAt,
        riskSeverity: 'critical',
        riskCategory: 'schedule',
        reason: '关键物料将晚于要求到货日，需人工升级跟进',
        recommendedAction: '立即升级供应商与内部计划，并每日跟踪恢复时间',
      });

      const afterPortfolio = await request('/api/procurement/workbench', { token: token('tenant:a') });
      assert.equal(afterPortfolio.status, 200);
      assert.equal(afterPortfolio.body['portfolio']['generatedAt'], markedAt);
      const markedPo = afterPortfolio.body['portfolio']['items'].find((item: Record<string, unknown>) => item['id'] === 'po:a');
      assert.equal(markedPo['risk'], 'medium');
      assert.equal(markedPo['riskScore'], 69);
      assert.equal(markedPo['riskPublicationState'], 'published');
      assert.equal(markedPo['riskModel']['evidenceCoverage'], 1);
      assert.equal(markedPo['riskModel']['totalScore'], 69);
      assert.equal(markedPo['riskModel']['components']['complianceApproval']['score'], 100);
      const manualRiskFactor = markedPo['riskFactors'].find((factor: Record<string, unknown>) => factor['code'] === 'exception:manual_purchase_order_risk');
      assert.equal(markedPo['actionReadiness']['mark_at_risk']['ready'], false);

      const exceptionRow = store.db.prepare(`SELECT id,json FROM runtime_exceptions
        WHERE tenant_id=? AND object_id=? AND json_extract(json,'$.type')='manual_purchase_order_risk'
        ORDER BY updated_at DESC,id LIMIT 1`).get('tenant:a', 'po:a') as { id: string; json: string };
      const exception = JSON.parse(exceptionRow.json) as Record<string, unknown>;

      assert.deepEqual(manualRiskFactor, {
        code: 'exception:manual_purchase_order_risk',
        label: '人工风险标记',
        score: 100,
        evidence: '关键物料将晚于要求到货日，需人工升级跟进',
        evidenceDetail: {
          exceptionId: exceptionRow.id,
          category: 'schedule',
          markedBy: 'human:risk-manager',
          markedAt,
          recommendedAction: '立即升级供应商与内部计划，并每日跟踪恢复时间',
        },
      });
      assert.equal((exception['context'] as Record<string, unknown>)['source'], 'human_mark_at_risk');

      const afterContext = await request('/api/procurement/workbench/context/po%3Aa', { token: token('tenant:a') });
      assert.equal(afterContext.status, 200);
      assert.deepEqual(afterContext.body['actionReadiness']['mark_at_risk'], {
        ready: false,
        code: 'already_marked',
        message: '该 PO 已有未解决的人工风险标记，请先在统一异常中心处理现有记录。',
        exceptionId: exceptionRow.id,
      });
      assert.deepEqual(markedPo['actionReadiness']['mark_at_risk'], afterContext.body['actionReadiness']['mark_at_risk']);
      const contextException = afterContext.body['exceptions'].find((item: Record<string, unknown>) => item['id'] === exceptionRow.id);
      assert.equal(contextException['type'], 'manual_purchase_order_risk');
      assert.equal(contextException['severity'], 'critical');
      assert.equal(contextException['recommendedAction'], '立即升级供应商与内部计划，并每日跟踪恢复时间');

      const tenantBPortfolio = await request('/api/procurement/workbench', { token: token('tenant:b') });
      assert.equal(tenantBPortfolio.status, 200);
      assert.equal(JSON.stringify(tenantBPortfolio.body).includes(exceptionRow.id), false);
      const tenantBPo = tenantBPortfolio.body['portfolio']['items'].find((item: Record<string, unknown>) => item['id'] === 'po:b');
      assert.deepEqual(tenantBPo['actionReadiness']['mark_at_risk'], {
        ready: true,
        code: 'ready',
        message: '可创建人工风险事实并进入统一异常与审计链。',
      });

      const tenantBContext = await request('/api/procurement/workbench/context/po%3Ab', { token: token('tenant:b') });
      assert.equal(tenantBContext.status, 200);
      assert.deepEqual(tenantBContext.body['actionReadiness']['mark_at_risk'], tenantBPo['actionReadiness']['mark_at_risk']);
      assert.equal(JSON.stringify(tenantBContext.body).includes(exceptionRow.id), false);

      store.db.prepare('DELETE FROM runtime_activities WHERE tenant_id=? AND id=?').run('tenant:a', `activity:po-risk:${exceptionRow.id}`);
      store.db.prepare('DELETE FROM runtime_exceptions WHERE tenant_id=? AND id=?').run('tenant:a', exceptionRow.id);
    });

    await t.test('不同租户只能看到自己的行，无数据租户返回零和空数组', async () => {
      const tenantB = await request('/api/procurement/workbench', { token: token('tenant:b') });
      assert.equal(tenantB.status, 200);
      assert.equal(tenantB.body['documents']['requisitions']['items'][0].id, 'requisition:b');
      assert.equal(tenantB.body['documents']['communications']['items'][0].id, 'communication:b');
      assert.equal(JSON.stringify(tenantB.body).includes('requisition:a'), false);

      const empty = await request('/api/procurement/workbench', { token: token('tenant:empty') });
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body['counts'], {
        items: 0, contacts: 0, suppliers: 0, requisitions: 0, rfqs: 0, quotes: 0, awards: 0,
        purchaseOrders: 0, confirmations: 0, productionProgress: 0, shipments: 0, receipts: 0, invoices: 0,
        matches: 0, communications: 0, inbox: 0, alerts: 0,
        pendingTasks: 0, pendingApprovals: 0, openExceptions: 0,
      });
      assert.deepEqual(empty.body['views']['contacts']['items'], []);
      assert.deepEqual(empty.body['views']['items']['items'], []);
      assert.deepEqual(empty.body['views']['inbox']['items'], []);
      assert.deepEqual(empty.body['views']['alerts']['items'], []);
      assert.deepEqual(empty.body['documents']['suppliers']['items'], []);
      assert.deepEqual(empty.body['documents']['purchaseOrders']['items'], []);
      assert.deepEqual(empty.body['documents']['productionProgress']['items'], []);
      assert.deepEqual(empty.body['documents']['communications']['items'], []);
      assert.deepEqual(empty.body['tasks']['items'], []);
      assert.deepEqual(empty.body['approvals']['items'], []);
      assert.deepEqual(empty.body['executionApprovals']['items'], []);
      assert.deepEqual(empty.body['exceptions']['items'], []);
      assert.deepEqual(empty.body['recentActivities']['items'], []);
      assert.deepEqual(empty.body['operations'], {
        tracked: 0, running: 0, waitingExternal: 0, waitingAction: 0, exceptions: 0, completedLast7Days: 0,
        byStatus: { tasks: {}, purchaseOrders: {}, approvals: {}, exceptions: {}, outbox: {} },
      });
      assert.deepEqual(empty.body['portfolio']['metrics'], {
        highRisk: 0, overdue: 0, requireAttention: 0, activePurchaseOrders: 0,
        localProcurement: 0, importProcurement: 0, unclassifiedRoute: 0, atRiskValueByCurrency: {},
      });
      assert.deepEqual(empty.body['portfolio']['items'], []);
    });

    await t.test('上下文可从任务、审批、异常反查 PO 并展开收货、发票、匹配和活动链', async () => {
      for (const requestedId of ['task:a', 'approval:a', 'exception:a']) {
        const response = await request(`/api/procurement/workbench/context/${encodeURIComponent(requestedId)}`, { token: token('tenant:a') });
        assert.equal(response.status, 200, `${requestedId}: ${JSON.stringify(response.body)}`);
        assert.equal(response.body['requestedId'], requestedId);
        assert.equal(response.body['objectId'], 'po:a');
        assert.equal(response.body['root']['id'], 'po:a');
        assert.deepEqual(response.body['purchaseOrders'].map((item: Record<string, unknown>) => item['id']), ['po:a']);
        assert.equal(response.body['purchaseOrders'][0]['displayNumber'], 'PO-a');
        assert.deepEqual(response.body['requisitions'].map((item: Record<string, unknown>) => item['id']), ['requisition:a']);
        assert.deepEqual(response.body['rfqs'].map((item: Record<string, unknown>) => item['id']), ['rfq:a']);
        assert.deepEqual(response.body['quotes'].map((item: Record<string, unknown>) => item['id']), ['quote:a']);
        assert.deepEqual(response.body['awards'].map((item: Record<string, unknown>) => item['id']), ['award:a']);
        assert.deepEqual(response.body['comparisons'].map((item: Record<string, unknown>) => item['id']), ['comparison:a']);
        assert.deepEqual(response.body['productionProgress'].map((item: Record<string, unknown>) => item['id']), ['production-progress:a']);
        assert.deepEqual(response.body['linesByDocument']['production-progress:a'], [{
          id: 'production-progress-line:a', progressId: 'production-progress:a', poLineId: 'po-line:a',
          lineNumber: '10', itemId: 'item:a', description: '测试物料 a', uom: 'EA',
          progressStatus: 'delayed', completionPercent: 40, completedQty: 4,
          expectedReadyAt: '2026-08-23T00:00:00.000Z', note: '关键原料晚到两天',
        }]);
        assert.deepEqual(response.body['shipments'].map((item: Record<string, unknown>) => item['id']), ['shipment:a']);
        assert.deepEqual(response.body['transportEvents'].map((item: Record<string, unknown>) => item['id']), ['transport-event:a']);
        assert.deepEqual(response.body['receipts'].map((item: Record<string, unknown>) => item['id']), ['receipt:a']);
        assert.deepEqual(response.body['invoices'].map((item: Record<string, unknown>) => item['id']), ['invoice:a']);
        assert.deepEqual(response.body['matches'].map((item: Record<string, unknown>) => item['id']), ['match:a']);
        assert.ok(response.body['tasks'].some((item: Record<string, unknown>) => item['id'] === 'task:a'));
        assert.ok(response.body['approvals'].some((item: Record<string, unknown>) => item['id'] === 'approval:a'));
        assert.ok(response.body['exceptions'].some((item: Record<string, unknown>) => item['id'] === 'exception:a'));
        assert.deepEqual(response.body['activities'].map((item: Record<string, unknown>) => item['id']), ['activity:a']);
        assert.deepEqual(response.body['executionApprovals'].map((item: Record<string, unknown>) => item['id']), ['procurement-approval:a']);
        assert.deepEqual(response.body['quantityProjections'], [{
          poLineId: 'po-line:a', orderedQty: 10, confirmedQty: 0, shippedQty: 0,
          receivedQty: 0, invoicedQty: 0, cancelledQty: 0,
        }]);
        assert.deepEqual(response.body['stageTimeline'].map((stage: Record<string, unknown>) => [stage['id'], stage['state']]), [
          ['po_sent', 'completed'],
          ['supplier_commitment', 'active'],
          ['fulfilment_production', 'pending'],
          ['dispatch_transit', 'pending'],
          ['delivery_grn', 'pending'],
        ]);
        assert.equal(response.body['stageTimeline'][0]['evidenceConfidence'], 'inferred_from_observed_status');
        assert.equal(response.body['stageTimeline'][1]['evidenceConfidence'], 'observed');
        assert.equal(response.body['stageTimeline'][1]['events'][0]['sourceKind'], 'document_snapshot');
        assert.equal(response.body['stageTimeline'][1]['events'][0]['evidence']['exactTransitionTime'], false);
        assert.equal(response.body['stageTimeline'][1]['sla'], null);
        assert.equal(
          response.body['poDetail']['history']['events'].some((event: Record<string, unknown>) =>
            event['type'] === 'observed_document_status'
            && (event['evidence'] as Record<string, unknown> | undefined)?.['sourceKind'] === 'document_snapshot'),
          false,
          '从文档快照推断的当前状态只属于阶段时间线，不得冒充 History 业务活动',
        );
        assert.equal(response.body['outbox'][0]['id'], 'outbox:a');
        assert.equal(response.body['outbox'][0]['status'], 'failed');
        assert.equal(response.body['outbox'][0]['attempts'], 3);
        assert.equal(response.body['outbox'][0]['error'], 'password=[REDACTED]');
        assert.equal('payload' in response.body['outbox'][0], false);
        assert.equal('payloadJson' in response.body['outbox'][0], false);
        assert.equal(response.body['poDetail']['supplier']['id'], 'supplier:a', '必须按当前 PO supplierId 精确关联');
        assert.equal(response.body['poDetail']['supplier']['name'], '供应商 a');
        assert.equal(response.body['poDetail']['supplierProfile']['route'], 'local');
        assert.equal(response.body['poDetail']['supplierProfile']['defaultLeadTimeDays'], 14);
        assert.deepEqual(response.body['poDetail']['items']['rows'][0], {
          id: 'po-line:a', item: '测试物料 a', description: '测试物料 a', category: null,
          ordered: 10, confirmed: 0, unit: 'EA', unitPrice: 20, tax: null, total: 200,
          shipped: 0, received: 0, status: null, currency: 'CNY', lineNumber: '10',
        });
        assert.deepEqual(response.body['poDetail']['documents']['kpis'], { total: 3, verified: 2, pending: 1, missing: 1 });
        assert.equal(response.body['poDetail']['documents']['requirements'].find((item: Record<string, unknown>) => item['id'] === 'packing_list')['state'], 'missing');
        assert.equal(response.body['poDetail']['history']['events'].some((item: Record<string, unknown>) => item['type'] === 'purchase_order_amendment_requested'), true);
        assert.deepEqual(response.body['purchaseOrderCancellation'], {
          requestId: 'po-cancellation:a', state: 'unknown', sourcePoVersion: 1,
          outboxId: 'outbox:cancel:a', idempotencyKey: 'cancel-key:a', reason: '项目取消已批准',
        });
        assert.deepEqual(response.body['poDetail']['communication']['kpis'], { total: 1, inbound: 1, outbound: 0, pendingDrafts: 0 });
        assert.equal(response.body['poDetail']['communication']['relatedThreads'][0]['id'], 'message:a');
        const metadata = response.body['attachments'].find((item: Record<string, unknown>) => item['id'] === 'attachment:a:spec');
        assert.deepEqual(metadata, {
          id: 'attachment:a:spec', fileName: 'spec-a.pdf', contentType: 'application/pdf', sizeBytes: 2048,
          url: 'https://files.example.test/a/spec.pdf', sourceDocumentId: 'requisition:a',
        });
        const placeholder = response.body['attachments'].find((item: Record<string, unknown>) => item['id'] === 'attachment:a:legacy');
        assert.deepEqual(placeholder, {
          id: 'attachment:a:legacy', fileName: 'attachment:a:legacy', contentType: 'application/octet-stream',
          sizeBytes: 0, sourceDocumentId: 'requisition:a',
        });
        assert.equal('url' in placeholder, false);
        const cleanStored = response.body['attachments'].find((item: Record<string, unknown>) => item['id'] === 'attachment:a:po-clean');
        assert.deepEqual(cleanStored, {
          id: 'attachment:a:po-clean', fileName: 'po-a-clean.txt', contentType: 'text/plain', sizeBytes: Buffer.byteLength('PO a 已扫描附件', 'utf8'),
          sourceDocumentId: 'po:a', securityStatus: 'clean', processingStatus: 'parsed', detectedContentType: 'text/plain',
          version: 1, createdBy: 'test:seed', createdAt: at,
          url: '/api/procurement/attachments/attachment%3Aa%3Apo-clean/content',
        });
        const pendingStored = response.body['attachments'].find((item: Record<string, unknown>) => item['id'] === 'attachment:a:po-pending');
        assert.deepEqual(pendingStored, {
          id: 'attachment:a:po-pending', fileName: 'po-a-pending.txt', contentType: 'text/plain', sizeBytes: Buffer.byteLength('PO a 待扫描附件', 'utf8'),
          sourceDocumentId: 'po:a', securityStatus: 'pending_scan', processingStatus: 'queued', detectedContentType: 'text/plain',
          version: 1, createdBy: 'test:seed', createdAt: at,
        });
        assert.equal('url' in pendingStored, false, '未扫描附件不能获得可打开地址');
      }

      const invoiceLookup = await request('/api/procurement/workbench/context/invoice%3Aa', { token: token('tenant:a') });
      assert.equal(invoiceLookup.status, 200);
      assert.equal(invoiceLookup.body['root']['id'], 'invoice:a');
      assert.deepEqual(invoiceLookup.body['purchaseOrders'].map((item: Record<string, unknown>) => item['id']), ['po:a']);
      assert.deepEqual(invoiceLookup.body['matches'].map((item: Record<string, unknown>) => item['id']), ['match:a']);
      assert.deepEqual(invoiceLookup.body['requisitions'].map((item: Record<string, unknown>) => item['id']), ['requisition:a']);

      const rfqLookup = await request('/api/procurement/workbench/context/rfq%3Aa', { token: token('tenant:a') });
      assert.equal(rfqLookup.status, 200);
      assert.equal(rfqLookup.body['root']['id'], 'rfq:a');
      assert.deepEqual(rfqLookup.body['requisitions'].map((item: Record<string, unknown>) => item['id']), ['requisition:a']);
      assert.deepEqual(rfqLookup.body['quotes'].map((item: Record<string, unknown>) => item['id']), ['quote:a']);
      assert.deepEqual(rfqLookup.body['comparisons'].map((item: Record<string, unknown>) => item['id']), ['comparison:a']);
      assert.deepEqual(rfqLookup.body['suppliers'].map((item: Record<string, unknown>) => item['id']), ['supplier:a', 'supplier:a:secondary']);
      assert.deepEqual(rfqLookup.body['purchaseOrders'].map((item: Record<string, unknown>) => item['id']), ['po:a']);
      assert.deepEqual(rfqLookup.body['communications'].map((item: Record<string, unknown>) => item['id']), ['communication:a']);
      assert.equal(typeof rfqLookup.body['communications'][0]['body'], 'string');
      assert.equal(rfqLookup.body['communications'][0]['body'], 'token=[REDACTED]');
      assert.equal(JSON.stringify(rfqLookup.body).includes('communication-body-secret'), false);
    });

    await t.test('文档投影携带真实来源、版本和处理时间，生成快照不冒充扫描附件', async () => {
      const response = await request('/api/procurement/workbench/context/po%3Aa', { token: token('tenant:a') });
      assert.equal(response.status, 200);
      const rows = response.body['poDetail']['documents']['rows'] as Array<Record<string, unknown>>;
      const attachment = rows.find((row) => row['id'] === 'attachment:a:po-clean')!;
      assert.equal(attachment['source'], 'stored_attachment');
      assert.equal(attachment['sourceDocumentId'], 'po:a');
      assert.equal(attachment['version'], 1);
      assert.equal(attachment['securityStatus'], 'clean');
      assert.equal(attachment['processingStatus'], 'parsed');
      assert.equal(attachment['verified'], true);
      assert.equal(attachment['createdBy'], 'test:seed');
      assert.equal(attachment['createdAt'], at);
      assert.equal(attachment['updatedAt'], at);
      const snapshot = rows.find((row) => row['snapshotId'] === 'po-snapshot:a')!;
      assert.equal(snapshot['id'], 'po-document:a');
      assert.equal(snapshot['source'], 'generated_snapshot');
      assert.equal(snapshot['version'], 1);
      assert.equal(snapshot['templateVersion'], 1);
      assert.equal(snapshot['securityStatus'], null);
      assert.equal(snapshot['processingStatus'], 'generated');
      assert.equal(snapshot['verified'], true);
      assert.equal(snapshot['updatedAt'], at);
      assert.equal(snapshot['url'], '/api/procurement/purchase-order-document-snapshots/po-snapshot%3Aa/pdf');
    });

    await t.test('供应商运营档案地址为空时 PO 上下文仍可读取并明确返回 null', async () => {
      store.db.prepare(`UPDATE procurement_supplier_operating_profiles SET address_json=?
        WHERE tenant_id=? AND supplier_id=?`).run(JSON.stringify(null), 'tenant:a', 'supplier:a');
      const response = await request('/api/procurement/workbench/context/po%3Aa', { token: token('tenant:a') });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body['poDetail']['supplierProfile']['address'], null);
      assert.equal(response.body['poDetail']['supplierProfile']['route'], 'local');
    });

    await t.test('文档核验同时要求安全扫描和解析通过，隔离或失败文件不伪装成可用证据', async () => {
      try {
        for (const [security, processing, status, verified, canOpen] of [
          ['clean', 'queued', 'pending', false, true],
          ['clean', 'parse_failed', 'pending', false, true],
          ['clean', 'needs_ocr', 'pending', false, true],
          ['clean', 'needs_specialist', 'pending', false, true],
          ['quarantined', 'parsed', 'pending', false, false],
          ['pending_scan', 'queued', 'pending', false, false],
          ['clean', 'parsed', 'verified', true, true],
        ] as const) {
          store.db.prepare('UPDATE procurement_attachments SET security_status=?,processing_status=?,version=3,parsed_at=? WHERE tenant_id=? AND id=?')
            .run(security, processing, '2026-09-06T01:02:03.000Z', 'tenant:a', 'attachment:a:po-clean');
          const response = await request('/api/procurement/workbench/context/po%3Aa', { token: token('tenant:a') });
          assert.equal(response.status, 200);
          const documents = response.body['poDetail']['documents'];
          const row = documents['rows'].find((entry: Record<string, unknown>) => entry['id'] === 'attachment:a:po-clean');
          assert.equal(row['status'], status, `${security}/${processing}`);
          assert.equal(row['verified'], verified);
          assert.equal(row['securityStatus'], security);
          assert.equal(row['processingStatus'], processing);
          assert.equal(row['version'], 3);
          assert.equal(row['updatedAt'], '2026-09-06T01:02:03.000Z');
          assert.equal(Boolean(row['url']), canOpen, '可下载与可作为业务证据是不同门禁');
          assert.deepEqual(documents['kpis'], { total: 3, verified: verified ? 2 : 1, pending: verified ? 1 : 2, missing: 1 });
        }
      } finally {
        store.db.prepare("UPDATE procurement_attachments SET security_status='clean',processing_status='parsed',version=1,parsed_at=NULL WHERE tenant_id=? AND id=?")
          .run('tenant:a', 'attachment:a:po-clean');
      }
    });

    await t.test('进口 PO 文档页按已发布策略与持久化评估匹配必需单证，并把缺失项纳入参考文档列表', async () => {
      const policyId = 'import-document-policy:po-detail';
      const requirements = [
        { code: 'bill_of_lading', name: 'Bill of Lading', description: '承运人签发提单', required: true, requiredStage: 'dispatch_transit', expiryRequired: false },
        { code: 'certificate_of_origin', name: 'Certificate of Origin', description: '原产地证明', required: true, requiredStage: 'dispatch_transit', expiryRequired: false },
        { code: 'optional_note', name: 'Optional Note', description: '非必需备注', required: false, requiredStage: 'delivery_grn', expiryRequired: false },
      ];
      const evaluationSummary = {
        stage: 'dispatch_transit', status: 'missing', policyMissing: false,
        requirements: [
          { ...requirements[0], status: 'passed', evidence: '文件有效且安全扫描通过', document: { id: 'import-document:bl', attachmentId: 'attachment:a:po-clean' } },
          { ...requirements[1], status: 'missing', evidence: '尚未绑定有效文件' },
        ],
      };
      store.db.prepare(`INSERT INTO procurement_route_assignments
        (tenant_id,po_id,route,source,evidence_json,version,created_by,updated_by,created_at,updated_at)
        VALUES ('tenant:a','po:a','import','manual','{}',1,'human:a','human:a',?,?)`).run(at, at);
      store.db.prepare(`INSERT INTO procurement_import_document_policies
        (tenant_id,id,name,description,status,version,requirements_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
        VALUES ('tenant:a',?,'进口单证策略','真实策略匹配','published',3,?,'human:a','human:a','human:a',?,?,?)`)
        .run(policyId, JSON.stringify(requirements), at, at, at);
      store.db.prepare(`INSERT INTO procurement_import_documents
        (tenant_id,id,po_id,requirement_code,attachment_id,document_number,issued_at,expires_at,status,version,created_by,updated_by,created_at,updated_at)
        VALUES ('tenant:a','import-document:bl','po:a','bill_of_lading','attachment:a:po-clean','BL-001',?,NULL,'active',2,'human:a','human:a',?,?)`)
        .run(at, at, at);
      store.db.prepare(`INSERT INTO procurement_import_document_evaluations
        (tenant_id,po_id,policy_id,policy_version,status,summary_json,fingerprint,version,evaluated_at,updated_at)
        VALUES ('tenant:a','po:a',?,3,'missing',?,'fingerprint:po-detail',4,?,?)`)
        .run(policyId, JSON.stringify(evaluationSummary), at, at);
      try {
        const response = await request('/api/procurement/workbench/context/po%3Aa', { token: token('tenant:a') });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const documents = response.body['poDetail']['documents'];
        assert.deepEqual(documents['requirements'].map((item: Record<string, unknown>) => ({
          id: item['id'], label: item['label'], required: item['required'], state: item['state'], policyId: item['policyId'], policyVersion: item['policyVersion'],
        })), [
          { id: 'bill_of_lading', label: 'Bill of Lading', required: true, state: 'present', policyId, policyVersion: 3 },
          { id: 'certificate_of_origin', label: 'Certificate of Origin', required: true, state: 'missing', policyId, policyVersion: 3 },
        ]);
        assert.equal(documents['requirements'].some((item: Record<string, unknown>) => item['id'] === 'packing_list'), false, '策略存在时不得回落到名称猜测');
        const bound = documents['rows'].find((item: Record<string, unknown>) => item['id'] === 'attachment:a:po-clean');
        assert.equal(bound['category'], 'bill_of_lading');
        assert.equal(bound['requirementLabel'], 'Bill of Lading');
        assert.equal(bound['verified'], true);
        const missing = documents['rows'].find((item: Record<string, unknown>) => item['id'] === 'requirement:certificate_of_origin');
        assert.deepEqual({
          name: missing['name'], category: missing['category'], status: missing['status'], verified: missing['verified'], source: missing['source'],
        }, {
          name: 'Certificate of Origin', category: 'certificate_of_origin', status: 'missing', verified: false, source: 'required_rule',
        });
        assert.deepEqual(documents['kpis'], { total: 4, verified: 2, pending: 1, missing: 1 });
      } finally {
        store.db.prepare("DELETE FROM procurement_import_document_evaluations WHERE tenant_id='tenant:a' AND po_id='po:a'").run();
        store.db.prepare("DELETE FROM procurement_import_documents WHERE tenant_id='tenant:a' AND po_id='po:a'").run();
        store.db.prepare("DELETE FROM procurement_import_document_policies WHERE tenant_id='tenant:a' AND id=?").run(policyId);
        store.db.prepare("DELETE FROM procurement_route_assignments WHERE tenant_id='tenant:a' AND po_id='po:a'").run();
      }
    });

    await t.test('历史事件使用本条变更状态及中文类型，不混淆同类修改或丢失业务摘要', async () => {
      store.db.prepare(`INSERT INTO procurement_purchase_order_amendments
        (tenant_id,id,po_id,action,source_po_version,normalized_patch_json,state,outbox_id,receipt_reference,idempotency_key,actor_id,reason,created_at,updated_at,applied_at)
        VALUES ('tenant:a','po-amendment:applied:a','po:a','edit',1,'{}','applied',NULL,NULL,'history-applied-key','human:reviewer','Pending supplier wording',?,?,?)`)
        .run('2026-09-06T01:00:00.000Z', '2026-09-06T02:00:00.000Z', '2026-09-06T03:00:00.000Z');
      try {
        const response = await request('/api/procurement/workbench/context/po%3Aa', { token: token('tenant:a') });
        assert.equal(response.status, 200);
        const events = response.body['poDetail']['history']['events'] as Array<Record<string, unknown>>;
        const applied = events.find((event) => event['id'] === 'po-amendment:applied:a')!;
        assert.equal(applied['type'], 'purchase_order_amendment_applied');
        assert.equal(applied['typeLabel'], '采购订单修改');
        assert.equal(applied['label'], '采购订单修改（已应用）');
        assert.equal(applied['summary'], 'Pending supplier wording');
        assert.equal(applied['at'], '2026-09-06T03:00:00.000Z');
        assert.equal(applied['actor'], 'human:reviewer');
        const requested = events.find((event) => event['id'] === 'po-amendment:a')!;
        assert.equal(requested['type'], 'purchase_order_amendment_requested');
        assert.equal(requested['summary'], '调整到货日');
        const outbox = events.find((event) => event['id'] === 'outbox:a')!;
        assert.equal(outbox['typeLabel'], '采购订单跟进');
        assert.equal(outbox['label'], '采购订单跟进（失败）');
        assert.equal(outbox['state'], 'failed');
        const review = events.find((event) => event['id'] === 'activity:a')!;
        assert.equal(review['label'], '采购订单复核');
        assert.equal(review['summary'], '已复核采购单');
      } finally {
        store.db.prepare("DELETE FROM procurement_purchase_order_amendments WHERE tenant_id='tenant:a' AND id='po-amendment:applied:a'").run();
      }
    });

    await t.test('历史事件纵向聚合六类持久化事实、证据引用与租户隔离', async () => {
      const seedHistorySources = (tenantId: string, suffix: string, note: string) => {
        const poId = `po:${suffix}`;
        store.db.prepare(`INSERT INTO procurement_po_stage_events
          (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          tenantId, `history-stage:${suffix}`, poId, 'supplier_commitment', 'supplier_difference_received', 'blocked',
          '2026-09-06T10:05:00.000Z', 'communication', `communication:${suffix}`, `connector:${suffix}`,
          JSON.stringify({ exactTransitionTime: true, reason: note }), '2026-09-06T10:05:00.000Z',
        );
        store.db.prepare(`INSERT INTO procurement_route_events
          (tenant_id,id,po_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`).run(
          tenantId, `history-route:${suffix}`, poId, `human:${suffix}`, 'route_assigned',
          JSON.stringify({ route: 'import', reason: note }), '2026-09-06T10:04:00.000Z',
        );
        store.db.prepare(`INSERT INTO procurement_route_evidence_document_events
          (tenant_id,id,po_id,document_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
          tenantId, `history-route-evidence:${suffix}`, poId, `route-document:${suffix}`, `human:${suffix}`, 'route_evidence_bound',
          JSON.stringify({ reference: `Contract ${suffix}`, note }), '2026-09-06T10:03:00.000Z',
        );
        store.db.prepare(`INSERT INTO procurement_sla_evaluation_events
          (tenant_id,id,po_id,policy_id,rule_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
          tenantId, `history-sla:${suffix}`, poId, `sla-policy:${suffix}`, `sla-rule:${suffix}`, 'evaluation_changed',
          JSON.stringify({ actorId: `system:sla:${suffix}`, status: 'breached', reason: note }), '2026-09-06T10:02:00.000Z',
        );
        store.db.prepare(`INSERT INTO procurement_import_document_events
          (tenant_id,id,po_id,import_document_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?)`).run(
          tenantId, `history-import-document:${suffix}`, poId, `import-document:${suffix}`, `human:${suffix}`, 'document_bound',
          JSON.stringify({ status: 'active', summary: note }), '2026-09-06T10:01:00.000Z',
        );
        store.db.prepare(`INSERT INTO procurement_po_line_quantity_events
          (tenant_id,source_system,source_event_id,po_line_id,dimension,delta,occurred_at,json) VALUES (?,?,?,?,?,?,?,?)`).run(
          tenantId, 'odoo', `history-quantity:${suffix}`, `po-line:${suffix}`, 'received', 4,
          '2026-09-06T10:00:00.000Z', JSON.stringify({ sourceEntityId: `grn:${suffix}`, sourceRevision: '2', note }),
        );
      };
      seedHistorySources('tenant:a', 'a', '仓库原文：4 cartons received.');
      seedHistorySources('tenant:b', 'b', 'tenant-b-history-secret');
      try {
        const response = await request('/api/procurement/workbench/context/po%3Aa', { token: token('tenant:a') });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const events = response.body['poDetail']['history']['events'] as Array<Record<string, any>>;
        const expectedIds = [
          'history-stage:a', 'history-route:a', 'history-route-evidence:a', 'history-sla:a',
          'history-import-document:a', 'quantity:odoo:history-quantity:a',
        ];
        assert.deepEqual(events.slice(0, 6).map((event) => event['id']), expectedIds);
        assert.deepEqual(events.slice(0, 6).map((event) => event['source']), [
          'stage', 'route', 'route_evidence', 'sla', 'import_document', 'quantity',
        ]);
        const stage = events.find((event) => event['id'] === 'history-stage:a')!;
        assert.deepEqual(stage['evidence'], {
          sourceKind: 'communication', sourceId: 'communication:a',
          details: { exactTransitionTime: true, reason: '仓库原文：4 cartons received.' },
        });
        const routeEvidence = events.find((event) => event['id'] === 'history-route-evidence:a')!;
        assert.equal(routeEvidence['evidence']['documentId'], 'route-document:a');
        const sla = events.find((event) => event['id'] === 'history-sla:a')!;
        assert.equal(sla['evidence']['policyId'], 'sla-policy:a');
        assert.equal(sla['evidence']['ruleId'], 'sla-rule:a');
        const importDocument = events.find((event) => event['id'] === 'history-import-document:a')!;
        assert.equal(importDocument['evidence']['importDocumentId'], 'import-document:a');
        const quantity = events.find((event) => event['id'] === 'quantity:odoo:history-quantity:a')!;
        assert.deepEqual({
          poLineId: quantity['evidence']['poLineId'], sourceSystem: quantity['evidence']['sourceSystem'],
          sourceEventId: quantity['evidence']['sourceEventId'], dimension: quantity['evidence']['dimension'], delta: quantity['evidence']['delta'],
        }, {
          poLineId: 'po-line:a', sourceSystem: 'odoo', sourceEventId: 'history-quantity:a', dimension: 'received', delta: 4,
        });
        assert.equal(JSON.stringify(response.body).includes('tenant-b-history-secret'), false);
      } finally {
        for (const tenantId of ['tenant:a', 'tenant:b']) {
          store.db.prepare("DELETE FROM procurement_po_stage_events WHERE tenant_id=? AND id LIKE 'history-stage:%'").run(tenantId);
          store.db.prepare("DELETE FROM procurement_route_events WHERE tenant_id=? AND id LIKE 'history-route:%'").run(tenantId);
          store.db.prepare("DELETE FROM procurement_route_evidence_document_events WHERE tenant_id=? AND id LIKE 'history-route-evidence:%'").run(tenantId);
          store.db.prepare("DELETE FROM procurement_sla_evaluation_events WHERE tenant_id=? AND id LIKE 'history-sla:%'").run(tenantId);
          store.db.prepare("DELETE FROM procurement_import_document_events WHERE tenant_id=? AND id LIKE 'history-import-document:%'").run(tenantId);
          store.db.prepare("DELETE FROM procurement_po_line_quantity_events WHERE tenant_id=? AND source_event_id LIKE 'history-quantity:%'").run(tenantId);
        }
      }
    });

    await t.test('上下文反查严格按租户隔离，跨租户 ID 返回 404', async () => {
      for (const requestedId of ['po:b', 'task:b', 'approval:b', 'exception:b']) {
        const response = await request(`/api/procurement/workbench/context/${encodeURIComponent(requestedId)}`, { token: token('tenant:a') });
        assert.equal(response.status, 404, requestedId);
        assert.equal(response.body['code'], 'PROCUREMENT_CONTEXT_NOT_FOUND');
      }
      const own = await request('/api/procurement/workbench/context/po%3Aa', { token: token('tenant:a') });
      assert.equal(JSON.stringify(own.body).includes('spec-b.pdf'), false);
      assert.equal(JSON.stringify(own.body).includes('attachment:b:'), false);
      assert.equal(JSON.stringify(own.body).includes('po-b-clean.txt'), false);
      assert.equal(JSON.stringify(own.body['stageTimeline']).includes('po:b'), false);
    });

    await t.test('精确供应商差异证据优先于 ERP 状态观察，且时间线只有一个当前阶段', async () => {
      const row = store.db.prepare(`SELECT json FROM procurement_documents WHERE tenant_id=? AND id=?`).get('tenant:a', 'po:a') as { json: string };
      const po = JSON.parse(row.json) as Record<string, unknown>;
      po['status'] = 'confirmed';
      po['updatedAt'] = '2026-08-21T02:00:00.000Z';
      store.db.prepare(`UPDATE procurement_documents SET status='confirmed',json=?,updated_at=? WHERE tenant_id=? AND id=?`)
        .run(JSON.stringify(po), String(po['updatedAt']), 'tenant:a', 'po:a');
      store.db.prepare(`INSERT INTO procurement_po_stage_events
        (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run('tenant:a', 'po-stage-event:exact-supplier-difference', 'po:a', 'supplier_commitment', 'supplier_difference_received', 'active',
          '2026-08-21T01:00:00.000Z', 'communication', 'communication:a', 'connector:email', JSON.stringify({ exactTransitionTime: true, reason: '数量与交期差异待审批' }), '2026-08-21T01:00:00.000Z');
      store.db.prepare(`INSERT INTO procurement_po_stage_events
        (tenant_id,id,po_id,stage,event_type,state,occurred_at,source_kind,source_id,actor_id,evidence_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run('tenant:a', 'po-stage-event:observed-fulfilment', 'po:a', 'fulfilment_production', 'observed_status_backfill', 'active',
          '2026-08-21T02:00:00.000Z', 'migration', 'migration:test', 'system:migration', JSON.stringify({ exactTransitionTime: false, observedStatus: 'confirmed' }), '2026-08-21T02:00:00.000Z');

      const response = await request('/api/procurement/workbench/context/po%3Aa', { token: token('tenant:a') });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body['stageTimeline'].map((stage: Record<string, unknown>) => [stage['id'], stage['state']]), [
        ['po_sent', 'completed'],
        ['supplier_commitment', 'active'],
        ['fulfilment_production', 'pending'],
        ['dispatch_transit', 'pending'],
        ['delivery_grn', 'pending'],
      ]);
      assert.equal(response.body['stageTimeline'].filter((stage: Record<string, unknown>) => stage['state'] === 'active').length, 1);
      assert.equal(response.body['stageTimeline'][0]['evidenceConfidence'], 'inferred_from_observed_status');
      const workbench = await request('/api/procurement/workbench', { token: token('tenant:a') });
      const portfolioPo = workbench.body['portfolio']['items'].find((item: Record<string, unknown>) => item['id'] === 'po:a');
      assert.equal(portfolioPo['stage'], 'supplier_commitment');
      assert.equal(portfolioPo['nextAction'], '获取供应商确认');
    });

    await t.test('SQLite 异常返回固定脱敏错误', async () => {
      store.db.prepare("UPDATE procurement_documents SET json=? WHERE tenant_id=? AND kind='communication' AND id=?").run('{"apiKey":"database-secret",broken}', 'tenant:a', 'communication:a');
      const response = await request('/api/procurement/workbench', { token: token('tenant:a') });
      assert.equal(response.status, 503);
      assert.equal(response.body['code'], 'WORKBENCH_READ_FAILED');
      assert.equal(JSON.stringify(response.body).includes('database-secret'), false);
    });

    await t.test('SQLite 锁等待或超时返回固定脱敏超时错误', async () => {
      activeDb = { exec: () => { throw new Error('database is locked token=lock-secret'); } } as unknown as DatabaseSync;
      try {
        const response = await request('/api/procurement/workbench', { token: token('tenant:a') });
        assert.equal(response.status, 503);
        assert.equal(response.body['code'], 'WORKBENCH_READ_TIMEOUT');
        assert.equal(JSON.stringify(response.body).includes('lock-secret'), false);
      } finally {
        activeDb = store.db;
      }
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
