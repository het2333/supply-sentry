import type { DatabaseSync } from 'node:sqlite';
import type { PurchaseOrder, Supplier } from '@readywork/core';

export interface ProcurementRouteEvidenceCandidate {
  readonly id: string;
  readonly type: 'erp_field' | 'route_document';
  readonly evidenceType: 'erp_field' | 'contract' | 'incoterm';
  readonly eligible: boolean;
  readonly reference: string;
  readonly label: string;
  readonly summary: string;
  readonly sourceSystem: string;
  readonly sourceEntity: 'purchase_order' | 'supplier' | 'route_document';
  readonly supplierId?: string;
  readonly supplierVersion?: number;
  readonly purchaseOrderId: string;
  readonly purchaseOrderVersion: number;
  readonly observedAt: string;
  readonly fields: Readonly<{
    incotermId?: number;
    incotermName?: string;
    incotermLocation?: string;
    documentId?: string;
    documentVersion?: number;
    businessReference?: string;
    attachmentId?: string;
    attachmentVersion?: number;
    sha256?: string;
    fileName?: string;
    sizeBytes?: number;
    securityStatus?: string;
    processingStatus?: string;
    detectedContentType?: string;
    countryCode?: string;
    countryName?: string;
    city?: string;
    street?: string;
    street2?: string;
    postalCode?: string;
  }>;
}

interface VersionedDocumentRow { version: number; json: string }

function parseDocument<T>(row: VersionedDocumentRow | undefined): T | undefined {
  if (!row) return undefined;
  try {
    const value = JSON.parse(row.json) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as T : undefined;
  } catch {
    return undefined;
  }
}

function normalizedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveId(value: unknown): number | undefined {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

type RouteAwarePurchaseOrder = PurchaseOrder & {
  readonly incotermId?: number;
  readonly incotermName?: string;
  readonly incotermLocation?: string;
};

/**
 * Returns only evidence present in current versioned ERP documents. A PO-level
 * Incoterm is offered before supplier master data because it is specific to the
 * transaction. Neither source is converted into a local/import decision; the
 * procurement manager still makes and records that decision.
 */
export function routeEvidenceCandidates(
  db: DatabaseSync,
  tenantId: string,
  purchaseOrderId: string,
): ProcurementRouteEvidenceCandidate[] {
  const poRow = db.prepare(`SELECT version,json FROM procurement_documents
    WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(tenantId, purchaseOrderId) as unknown as VersionedDocumentRow | undefined;
  const purchaseOrder = parseDocument<RouteAwarePurchaseOrder>(poRow);
  if (!purchaseOrder || !poRow) return [];

  const candidates: ProcurementRouteEvidenceCandidate[] = [];
  const incotermName = normalizedText(purchaseOrder.incotermName);
  if (purchaseOrder.sourceSystem === 'odoo' && incotermName) {
    const incotermId = positiveId(purchaseOrder.incotermId);
    const incotermLocation = normalizedText(purchaseOrder.incotermLocation);
    const fields = {
      ...(incotermId ? { incotermId } : {}),
      incotermName,
      ...(incotermLocation ? { incotermLocation } : {}),
    };
    const reference = `odoo:purchase-order-incoterm:${purchaseOrder.id}:v${poRow.version}`;
    candidates.push({
      id: reference,
      type: 'erp_field',
      evidenceType: 'erp_field',
      eligible: true,
      reference,
      label: 'Odoo PO Incoterm',
      summary: [incotermName, incotermLocation].filter((value): value is string => Boolean(value)).join(' · '),
      sourceSystem: purchaseOrder.sourceSystem,
      sourceEntity: 'purchase_order',
      supplierId: purchaseOrder.supplierId,
      purchaseOrderId: purchaseOrder.id,
      purchaseOrderVersion: poRow.version,
      observedAt: purchaseOrder.updatedAt,
      fields,
    });
  }

  const documentRows = db.prepare(`SELECT d.id,d.evidence_type,d.attachment_id,d.reference,d.version,d.updated_at,
      a.file_name,a.size_bytes,a.sha256,a.version AS attachment_version,a.status AS attachment_status,
      a.security_status,a.processing_status,COALESCE(a.detected_content_type,a.content_type) AS detected_content_type
    FROM procurement_route_evidence_documents d
    JOIN procurement_attachments a ON a.tenant_id=d.tenant_id AND a.id=d.attachment_id
    WHERE d.tenant_id=? AND d.po_id=? AND d.status='active'
    ORDER BY d.updated_at DESC,d.id`)
    .all(tenantId, purchaseOrder.id) as unknown as Array<{
      id: string; evidence_type: 'contract' | 'incoterm'; attachment_id: string; reference: string;
      version: number; updated_at: string; file_name: string; size_bytes: number; sha256: string;
      attachment_version: number; attachment_status: string; security_status: string; processing_status: string;
      detected_content_type: string;
    }>;
  for (const row of documentRows) {
    const eligible = row.attachment_status === 'active'
      && row.security_status === 'clean'
      && row.processing_status === 'parsed'
      && /^[a-f0-9]{64}$/iu.test(row.sha256)
      && Number.isSafeInteger(row.attachment_version) && row.attachment_version > 0;
    const reference = `route-document:${row.id}:v${row.version}:attachment-v${row.attachment_version}:${row.sha256}`;
    candidates.push({
      id: reference,
      type: 'route_document',
      evidenceType: row.evidence_type,
      eligible,
      reference,
      label: row.evidence_type === 'contract' ? '合同文件' : 'Incoterm 文件',
      summary: `${row.reference} · ${row.file_name}`,
      sourceSystem: 'attachment',
      sourceEntity: 'route_document',
      supplierId: purchaseOrder.supplierId,
      purchaseOrderId: purchaseOrder.id,
      purchaseOrderVersion: poRow.version,
      observedAt: row.updated_at,
      fields: {
        documentId: row.id,
        documentVersion: row.version,
        businessReference: row.reference,
        attachmentId: row.attachment_id,
        attachmentVersion: row.attachment_version,
        sha256: row.sha256,
        fileName: row.file_name,
        sizeBytes: row.size_bytes,
        securityStatus: row.security_status,
        processingStatus: row.processing_status,
        detectedContentType: row.detected_content_type,
      },
    });
  }

  const supplierRow = db.prepare(`SELECT version,json FROM procurement_documents
    WHERE tenant_id=? AND kind='supplier' AND id=?`).get(tenantId, purchaseOrder.supplierId) as unknown as VersionedDocumentRow | undefined;
  const supplier = parseDocument<Supplier>(supplierRow);
  if (purchaseOrder.sourceSystem !== 'odoo' || !supplier || !supplierRow || supplier.sourceSystem !== 'odoo') return candidates;

  const fields = {
    ...(normalizedText(supplier.countryCode) ? { countryCode: normalizedText(supplier.countryCode)! } : {}),
    ...(normalizedText(supplier.countryName) ? { countryName: normalizedText(supplier.countryName)! } : {}),
    ...(normalizedText(supplier.city) ? { city: normalizedText(supplier.city)! } : {}),
    ...(normalizedText(supplier.street) ? { street: normalizedText(supplier.street)! } : {}),
    ...(normalizedText(supplier.street2) ? { street2: normalizedText(supplier.street2)! } : {}),
    ...(normalizedText(supplier.postalCode) ? { postalCode: normalizedText(supplier.postalCode)! } : {}),
  };
  if (Object.keys(fields).length === 0) return candidates;

  const reference = `odoo:supplier-address:${supplier.id}:v${supplierRow.version}:po-v${poRow.version}`;
  const summary = [fields.countryName, fields.countryCode, fields.city, fields.street, fields.street2, fields.postalCode]
    .filter((value): value is string => Boolean(value)).join(' · ');
  candidates.push({
    id: reference,
    type: 'erp_field',
    evidenceType: 'erp_field',
    eligible: true,
    reference,
    label: 'Odoo 供应商地址',
    summary,
    sourceSystem: supplier.sourceSystem,
    sourceEntity: 'supplier',
    supplierId: supplier.id,
    supplierVersion: supplierRow.version,
    purchaseOrderId: purchaseOrder.id,
    purchaseOrderVersion: poRow.version,
    observedAt: supplier.updatedAt,
    fields,
  });
  return candidates;
}
