import type { DatabaseSync } from 'node:sqlite';
import { purchaseOrderOdooCorrelationKey } from '@readywork/persistence';

export const PO_MISSING_FACT_ORDER = [
  'odoo_purchase_order',
  'supplier_confirmation',
  'production_progress',
  'shipment',
  'grn',
] as const;

export type PurchaseOrderMissingFact = (typeof PO_MISSING_FACT_ORDER)[number];

interface JsonRow {
  json: string;
}

function hasPoDocument(db: DatabaseSync, tenantId: string, kind: string, poId: string): boolean {
  return db.prepare(`SELECT 1 AS present FROM procurement_documents
    WHERE tenant_id=? AND kind=? AND json_extract(json,'$.poId')=? LIMIT 1`)
    .get(tenantId, kind, poId) !== undefined;
}

function hasAcceptedConfirmation(db: DatabaseSync, tenantId: string, poId: string): boolean {
  return db.prepare(`SELECT 1 AS present FROM procurement_documents
    WHERE tenant_id=? AND kind='confirmation' AND status='confirmed'
      AND json_extract(json,'$.poId')=? LIMIT 1`).get(tenantId, poId) !== undefined;
}

function hasValidatedOdooReference(value: unknown, expectedCorrelationKey: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const reference = value as Record<string, unknown>;
  return Number.isSafeInteger(reference.id) && Number(reference.id) > 0
    && typeof reference.name === 'string' && reference.name.trim().length > 0
    && reference.correlationKey === expectedCorrelationKey
    && typeof reference.createdAt === 'string' && Number.isFinite(Date.parse(reference.createdAt));
}

export function purchaseOrderMissingFacts(
  db: DatabaseSync,
  tenantId: string,
  poId: string,
): PurchaseOrderMissingFact[] {
  if (!tenantId.trim() || !poId.trim()) throw new Error('PO missing-fact tenantId 和 poId 不能为空');
  const row = db.prepare(`SELECT json FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(tenantId, poId) as JsonRow | undefined;
  if (!row) throw new Error('PO missing-fact 采购订单不存在或不属于当前租户');
  const po = JSON.parse(row.json) as { odooReference?: unknown };
  const present: Record<PurchaseOrderMissingFact, boolean> = {
    odoo_purchase_order: hasValidatedOdooReference(
      po.odooReference, purchaseOrderOdooCorrelationKey(tenantId, poId),
    ),
    supplier_confirmation: hasAcceptedConfirmation(db, tenantId, poId),
    production_progress: hasPoDocument(db, tenantId, 'production_progress', poId),
    shipment: hasPoDocument(db, tenantId, 'shipment', poId),
    grn: hasPoDocument(db, tenantId, 'receipt', poId),
  };
  return PO_MISSING_FACT_ORDER.filter((fact) => !present[fact]);
}
