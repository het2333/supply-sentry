import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { Communication, PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { createProcurementRepository } from '@readywork/persistence';
import { PUBLIC_DEMO_TENANT_ID } from './public-demo-mode.js';

export const PUBLIC_DEMO_SEED_VERSION = 'public-demo-v1' as const;

export const PUBLIC_DEMO_IDS = {
  normalPo: 'purchase-order:public-demo:normal',
  awaitingConfirmationPo: 'purchase-order:public-demo:awaiting-confirmation',
  vagueReplyPo: 'purchase-order:public-demo:vague-reply',
  partialShipmentPo: 'purchase-order:public-demo:partial',
  delayedImportPo: 'purchase-order:public-demo:delayed-import',
  shortDeliveryApproval: 'approval:public-demo:short-delivery',
  acceptedReceipt: 'receipt:public-demo:accepted',
  uncertainReceipt: 'receipt:public-demo:uncertain',
} as const;

export interface PublicDemoSeedSummary {
  tenantId: typeof PUBLIC_DEMO_TENANT_ID;
  seedVersion: typeof PUBLIC_DEMO_SEED_VERSION;
  generation: number;
  resetAt: string;
  scenarioCount: number;
}

type DemoPoSeed = {
  id: string;
  number: string;
  supplierId: string;
  status: string;
  route: 'local' | 'import';
  item: string;
  quantity: number;
  shipped: number;
  received: number;
  requiredOffsetHours: number;
  promisedOffsetHours: number | null;
};

function shifted(resetAt: string, hours: number): string {
  return new Date(Date.parse(resetAt) + hours * 3_600_000).toISOString();
}

function saveSuppliers(db: DatabaseSync, resetAt: string): void {
  const repository = createProcurementRepository(db, PUBLIC_DEMO_TENANT_ID);
  const suppliers: Supplier[] = [
    {
      id: 'supplier:public-demo:precision', tenantId: PUBLIC_DEMO_TENANT_ID, sourceSystem: 'public-demo', externalId: 'DEMO-SUP-001', status: 'active',
      createdAt: shifted(resetAt, -720), updatedAt: resetAt, name: '星海精密制造（演示）', currency: 'CNY', countryCode: 'CN', countryName: '中国', city: '苏州',
      contacts: [{ id: 'contact:public-demo:precision', name: '林工（演示）', email: 'lin.engineer@example.com', role: '计划专员', primary: true }],
    },
    {
      id: 'supplier:public-demo:electronics', tenantId: PUBLIC_DEMO_TENANT_ID, sourceSystem: 'public-demo', externalId: 'DEMO-SUP-002', status: 'active',
      createdAt: shifted(resetAt, -680), updatedAt: resetAt, name: '蓝山电子（演示）', currency: 'CNY', countryCode: 'CN', countryName: '中国', city: '深圳',
      contacts: [{ id: 'contact:public-demo:electronics', name: '陈主管（演示）', email: 'chen.manager@example.test', role: '客户经理', primary: true }],
    },
    {
      id: 'supplier:public-demo:global', tenantId: PUBLIC_DEMO_TENANT_ID, sourceSystem: 'public-demo', externalId: 'DEMO-SUP-003', status: 'active',
      createdAt: shifted(resetAt, -640), updatedAt: resetAt, name: 'Northwind Components (Demo)', currency: 'USD', countryCode: 'DE', countryName: 'Germany', city: 'Hamburg',
      contacts: [{ id: 'contact:public-demo:global', name: 'Alex Morgan (Demo)', email: 'alex.morgan@example.org', role: 'Account Manager', primary: true }],
    },
  ];
  for (const supplier of suppliers) repository.saveDocument('supplier', supplier);
}

function demoPurchaseOrders(): DemoPoSeed[] {
  return [
    { id: PUBLIC_DEMO_IDS.normalPo, number: 'PO-DEMO-1001', supplierId: 'supplier:public-demo:precision', status: 'received', route: 'local', item: '铝合金外壳', quantity: 5000, shipped: 5000, received: 5000, requiredOffsetHours: 168, promisedOffsetHours: 144 },
    { id: PUBLIC_DEMO_IDS.awaitingConfirmationPo, number: 'PO-DEMO-1002', supplierId: 'supplier:public-demo:electronics', status: 'awaiting_confirmation', route: 'local', item: '控制板 PCBA', quantity: 800, shipped: 0, received: 0, requiredOffsetHours: 240, promisedOffsetHours: null },
    { id: PUBLIC_DEMO_IDS.vagueReplyPo, number: 'PO-DEMO-1003', supplierId: 'supplier:public-demo:precision', status: 'confirmed', route: 'local', item: '液压阀体', quantity: 1200, shipped: 0, received: 0, requiredOffsetHours: 216, promisedOffsetHours: 192 },
    { id: PUBLIC_DEMO_IDS.partialShipmentPo, number: 'PO-DEMO-1004', supplierId: 'supplier:public-demo:electronics', status: 'partially_shipped', route: 'local', item: '温度传感器', quantity: 1000, shipped: 240, received: 0, requiredOffsetHours: 96, promisedOffsetHours: 72 },
    { id: PUBLIC_DEMO_IDS.delayedImportPo, number: 'PO-DEMO-1005', supplierId: 'supplier:public-demo:global', status: 'in_production', route: 'import', item: '伺服驱动器', quantity: 80, shipped: 0, received: 0, requiredOffsetHours: 120, promisedOffsetHours: 240 },
  ];
}

function savePurchaseOrders(db: DatabaseSync, resetAt: string): void {
  const repository = createProcurementRepository(db, PUBLIC_DEMO_TENANT_ID);
  for (const seed of demoPurchaseOrders()) {
    const orderedAt = shifted(resetAt, -168);
    const po = {
      id: seed.id,
      tenantId: PUBLIC_DEMO_TENANT_ID,
      sourceSystem: 'public-demo',
      externalId: seed.number,
      number: seed.number,
      status: seed.status,
      supplierId: seed.supplierId,
      currency: seed.supplierId.endsWith(':global') ? 'USD' : 'CNY',
      orderedAt,
      requiredInHouseAt: shifted(resetAt, seed.requiredOffsetHours),
      promisedAt: seed.promisedOffsetHours === null ? null : shifted(resetAt, seed.promisedOffsetHours),
      createdAt: orderedAt,
      updatedAt: resetAt,
    } as PurchaseOrder & { number: string };
    const line: PurchaseOrderLine = {
      id: `purchase-order-line:public-demo:${seed.number.slice(-4)}`,
      poId: seed.id,
      lineNumber: '10',
      itemId: `item:public-demo:${seed.number.slice(-4)}`,
      description: seed.item,
      uom: 'EA',
      orderedQty: seed.quantity,
      unitPrice: seed.supplierId.endsWith(':global') ? 890 : 42,
      currency: po.currency,
      requestedAt: orderedAt,
    };
    repository.saveDocument('purchase_order', po);
    repository.saveLine('purchase_order_line', po.id, line);
    const projection = {
      tenantId: PUBLIC_DEMO_TENANT_ID,
      poLineId: line.id,
      orderedQty: seed.quantity,
      confirmedQty: seed.status === 'awaiting_confirmation' ? 0 : seed.id === PUBLIC_DEMO_IDS.partialShipmentPo ? 800 : seed.quantity,
      shippedQty: seed.shipped,
      receivedQty: seed.received,
      invoicedQty: seed.received,
      cancelledQty: 0,
      events: [],
      appliedEventKeys: [],
      updatedAt: resetAt,
    };
    db.prepare(`INSERT INTO procurement_po_line_quantity_projections
      (tenant_id,po_line_id,ordered_qty,confirmed_qty,shipped_qty,received_qty,invoiced_qty,cancelled_qty,projection_json,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      PUBLIC_DEMO_TENANT_ID, line.id, projection.orderedQty, projection.confirmedQty, projection.shippedQty,
      projection.receivedQty, projection.invoicedQty, projection.cancelledQty, JSON.stringify(projection), resetAt,
    );
    db.prepare(`INSERT INTO procurement_route_assignments
      (tenant_id,po_id,route,source,evidence_json,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,?,?,'public_demo_seed',?,1,'system:public-demo','system:public-demo',?,?)`).run(
      PUBLIC_DEMO_TENANT_ID, po.id, seed.route, JSON.stringify({ synthetic: true, seedVersion: PUBLIC_DEMO_SEED_VERSION }), resetAt, resetAt,
    );
  }
}

function saveVagueReply(db: DatabaseSync, resetAt: string): void {
  const repository = createProcurementRepository(db, PUBLIC_DEMO_TENANT_ID);
  const body = '王经理您好，PO-DEMO-1003 大概下周能备好，先发一部分，具体数量明天再确认。';
  const communication: Communication = {
    id: 'communication:public-demo:vague-reply',
    tenantId: PUBLIC_DEMO_TENANT_ID,
    sourceSystem: 'public-demo',
    externalId: 'DEMO-MESSAGE-1003',
    status: 'received',
    businessObjectId: PUBLIC_DEMO_IDS.vagueReplyPo,
    businessObjectType: 'purchase_order',
    supplierId: 'supplier:public-demo:precision',
    channel: 'email',
    direction: 'inbound',
    messageId: '<demo-1003@example.com>',
    from: 'lin.engineer@example.com',
    subject: 'Re: PO-DEMO-1003 交期确认',
    body,
    attachmentIds: [],
    occurredAt: shifted(resetAt, -2),
    receivedAt: shifted(resetAt, -2),
    createdAt: shifted(resetAt, -2),
    updatedAt: shifted(resetAt, -2),
  };
  repository.saveDocument('communication', communication);
  const analysis = {
    association: { status: 'matched', poId: PUBLIC_DEMO_IDS.vagueReplyPo, evidence: 'PO-DEMO-1003' },
    extracted: { deliveryDate: null, quantity: null, shipmentStatus: 'partial_planned' },
    unknownFields: ['deliveryDate', 'quantity'],
    validation: 'review_required',
    approvalRequired: true,
    evidence: [{ field: 'shipmentStatus', text: '先发一部分' }],
    synthetic: true,
  };
  db.prepare(`INSERT INTO procurement_ai_reply_analyses
    (tenant_id,communication_id,po_id,status,model,po_version,result_json,error,attempts,created_at,updated_at)
    VALUES (?,?,?,'completed','deterministic-demo',1,?,NULL,1,?,?)`).run(
      PUBLIC_DEMO_TENANT_ID, communication.id, PUBLIC_DEMO_IDS.vagueReplyPo, JSON.stringify(analysis), shifted(resetAt, -2), shifted(resetAt, -2),
    );
}

function saveApprovalAndReceipts(db: DatabaseSync, resetAt: string, generation: number): void {
  const approval = {
    id: PUBLIC_DEMO_IDS.shortDeliveryApproval,
    tenantId: PUBLIC_DEMO_TENANT_ID,
    kind: 'supplier_confirmation',
    objectId: 'confirmation:public-demo:short-delivery',
    poId: PUBLIC_DEMO_IDS.partialShipmentPo,
    status: 'pending',
    requestedBy: 'ai:public-demo:procurement',
    requestedAt: shifted(resetAt, -1),
    reason: '供应商仅确认 800/1000 件，剩余 200 件需人工决定',
  };
  db.prepare(`INSERT INTO procurement_execution_approvals
    (tenant_id,id,kind,object_id,status,json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`).run(
      PUBLIC_DEMO_TENANT_ID, approval.id, approval.kind, approval.objectId, approval.status, JSON.stringify(approval), approval.requestedAt, approval.requestedAt,
    );

  const receipts = [
    {
      id: PUBLIC_DEMO_IDS.acceptedReceipt,
      aggregateId: PUBLIC_DEMO_IDS.normalPo,
      status: 'dispatched',
      outcome: 'accepted',
      action: 'purchase_order.followup',
    },
    {
      id: PUBLIC_DEMO_IDS.uncertainReceipt,
      aggregateId: PUBLIC_DEMO_IDS.delayedImportPo,
      status: 'failed',
      outcome: 'uncertain',
      action: 'purchase_order.amend',
    },
  ];
  for (const receipt of receipts) {
    const value = {
      id: receipt.id,
      tenantId: PUBLIC_DEMO_TENANT_ID,
      channel: receipt.action.endsWith('amend') ? 'erp' : 'email',
      connectorId: 'public-demo-simulator',
      action: receipt.action,
      aggregateId: receipt.aggregateId,
      idempotencyKey: `public-demo:${receipt.id}`,
      status: receipt.status,
      payload: { synthetic: true },
      attempts: 1,
      connectorResult: {
        receiptKind: 'simulated_demo', outcome: receipt.outcome, externalDelivery: false,
        connector: receipt.action.endsWith('amend') ? 'erp' : 'email', action: receipt.action,
        reference: `SIM-${receipt.outcome.toUpperCase()}-${receipt.id.slice(-8)}`, generatedAt: shifted(resetAt, -3), generation,
      },
      createdAt: shifted(resetAt, -3),
      updatedAt: shifted(resetAt, -3),
      ...(receipt.status === 'dispatched' ? { dispatchedAt: shifted(resetAt, -3) } : { failedAt: shifted(resetAt, -3), error: 'Simulated uncertain delivery requires reconciliation' }),
    };
    db.prepare(`INSERT INTO procurement_outbox
      (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,attempt,dispatched_at,failed_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      PUBLIC_DEMO_TENANT_ID, value.id, value.channel, value.connectorId, value.action, value.aggregateId, value.idempotencyKey,
      value.status, JSON.stringify(value.payload), JSON.stringify(value), 1,
      'dispatchedAt' in value ? value.dispatchedAt : null, 'failedAt' in value ? value.failedAt : null, value.createdAt, value.updatedAt,
    );
  }
}

function saveSupportingViews(db: DatabaseSync, resetAt: string): void {
  const slaRules = [{
    id: 'public-demo-supplier-confirmation', name: '供应商确认时限', enabled: true, route: 'all', stage: 'supplier_commitment', risk: 'all',
    deadlineBasis: 'stage_entry', targetOffsetHours: 24, warningHours: 4, graceHours: 0,
    followupIntervalHours: 24, maxFollowups: 3, escalationRole: '采购经理', messageCategory: 'acknowledgement_followup',
  }];
  db.prepare(`INSERT INTO procurement_sla_policies
    (tenant_id,id,name,description,status,version,rules_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
    VALUES (?,?,?,?,'published',1,?,?,?,?,?,?,?)`).run(
      PUBLIC_DEMO_TENANT_ID, 'sla:public-demo:v1', '公开演示 SLA', '合成数据的五阶段跟催策略', JSON.stringify(slaRules),
      'system:public-demo', 'system:public-demo', 'system:public-demo', resetAt, resetAt, resetAt,
    );
  db.prepare(`INSERT INTO procurement_message_drafts
    (tenant_id,id,purchase_order_id,supplier_id,channel,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at,sender_name,sender_title,sender_organization)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      PUBLIC_DEMO_TENANT_ID, 'draft:public-demo:followup', PUBLIC_DEMO_IDS.awaitingConfirmationPo, 'supplier:public-demo:electronics', 'email',
      'chen.manager@example.test', '请确认 PO-DEMO-1002 交期', '这是公开演示中的合成催交草稿，外部发送已禁用。',
      'acknowledgement_followup', 'public-demo:awaiting-confirmation', JSON.stringify({ synthetic: true }), 'draft', 1,
      'ai:public-demo:procurement', shifted(resetAt, -1), shifted(resetAt, -1), '公开演示采购团队', '采购经理', 'SupplySentry Demo',
    );
  db.prepare(`INSERT INTO procurement_notifications
    (tenant_id,id,fingerprint,type,severity,title,message,tag,object_type,object_id,evidence_json,status,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'unread',1,?,?)`).run(
      PUBLIC_DEMO_TENANT_ID, 'notification:public-demo:short-delivery', 'public-demo:short-delivery:g1', 'approval_required', 'high',
      '短交待审批', 'PO-DEMO-1004 供应商只确认 800/1000 件。', '需审批', 'purchase_order', PUBLIC_DEMO_IDS.partialShipmentPo,
      JSON.stringify({ approvalId: PUBLIC_DEMO_IDS.shortDeliveryApproval, synthetic: true }), shifted(resetAt, -1), shifted(resetAt, -1),
    );

  const attachmentContent = Buffer.from('Synthetic packing list for public demo. No customer data.\n', 'utf8');
  db.prepare(`INSERT INTO procurement_attachments
    (tenant_id,id,requisition_id,requisition_line_id,owner_type,owner_id,file_name,content_type,size_bytes,sha256,version,supersedes_id,extraction_status,extracted_text_preview,content,status,security_status,processing_status,detected_content_type,storage_backend,created_by,created_at)
    VALUES (?,?,?,NULL,'purchase_order',?,?,?,?,?,1,NULL,'text_extracted',?,?,'active','clean','parsed','text/plain','sqlite','system:public-demo',?)`).run(
      PUBLIC_DEMO_TENANT_ID, 'attachment:public-demo:packing-list', PUBLIC_DEMO_IDS.delayedImportPo, PUBLIC_DEMO_IDS.delayedImportPo,
      'packing-list-demo.txt', 'text/plain', attachmentContent.byteLength,
      createHash('sha256').update(attachmentContent).digest('hex'), attachmentContent.toString('utf8'), attachmentContent, resetAt,
    );
}

function saveScenarioCatalog(db: DatabaseSync, resetAt: string, generation: number): void {
  const labels: Record<string, string> = {
    [PUBLIC_DEMO_IDS.normalPo]: '正常已收货本地订单',
    [PUBLIC_DEMO_IDS.awaitingConfirmationPo]: '等待供应商确认',
    [PUBLIC_DEMO_IDS.vagueReplyPo]: '模糊回复与 AI 证据',
    [PUBLIC_DEMO_IDS.partialShipmentPo]: '未预告分批交付',
    [PUBLIC_DEMO_IDS.delayedImportPo]: '进口订单交期与单证风险',
    [PUBLIC_DEMO_IDS.shortDeliveryApproval]: '短交人工审批',
    [PUBLIC_DEMO_IDS.acceptedReceipt]: '已接受的模拟回执',
    [PUBLIC_DEMO_IDS.uncertainReceipt]: '需对账的不确定模拟回执',
  };
  const insert = db.prepare(`INSERT INTO public_demo_scenarios
    (tenant_id,id,kind,label,payload_json,created_at) VALUES (?,?,?,?,?,?)`);
  for (const id of Object.values(PUBLIC_DEMO_IDS)) {
    const simulationOutcome = id === PUBLIC_DEMO_IDS.delayedImportPo || id === PUBLIC_DEMO_IDS.uncertainReceipt
      ? 'uncertain'
      : 'accepted';
    insert.run(PUBLIC_DEMO_TENANT_ID, id, id.includes('purchase-order') ? 'purchase_order' : id.split(':')[0]!, labels[id]!, JSON.stringify({ generation, synthetic: true, simulationOutcome }), resetAt);
  }
}

export function seedPublicDemo(db: DatabaseSync, input: { resetAt: string; generation: number }): PublicDemoSeedSummary {
  saveSuppliers(db, input.resetAt);
  savePurchaseOrders(db, input.resetAt);
  saveVagueReply(db, input.resetAt);
  saveApprovalAndReceipts(db, input.resetAt, input.generation);
  saveSupportingViews(db, input.resetAt);
  saveScenarioCatalog(db, input.resetAt, input.generation);
  return {
    tenantId: PUBLIC_DEMO_TENANT_ID,
    seedVersion: PUBLIC_DEMO_SEED_VERSION,
    generation: input.generation,
    resetAt: input.resetAt,
    scenarioCount: Object.keys(PUBLIC_DEMO_IDS).length,
  };
}
