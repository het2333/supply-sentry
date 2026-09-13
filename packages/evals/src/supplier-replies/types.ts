export const SUPPLIER_REPLY_DATASET_VERSION = 'supplier-replies-v1' as const;
export const SUPPLIER_REPLY_SCHEMA_VERSION = 'supplier-reply-proposal-v1' as const;

export type SupplierReplyLocale = 'zh-CN' | 'en-US' | 'mixed' | 'qq-mail';
export type SupplierReplyDifficulty = 'basic' | 'intermediate' | 'adversarial';
export type ExpectedAssociation = 'matched' | 'ambiguous' | 'unmatched';
export type ExpectedValidation = 'accepted' | 'review_required' | 'rejected';
export type SupplierReplyField = 'deliveryDate' | 'quantity' | 'unitPrice' | 'currency' | 'productionStatus' | 'shipmentStatus' | 'trackingNumber' | 'eta';

export interface EvidenceSpan {
  field: SupplierReplyField;
  start: number;
  end: number;
  text: string;
}

export type SupplierReplyExtracted = Record<SupplierReplyField, string | null>;

export interface SupplierReplyExpected {
  association: { status: ExpectedAssociation; poId: string | null };
  extracted: SupplierReplyExtracted;
  unknownFields: SupplierReplyField[];
  evidence: EvidenceSpan[];
  validation: ExpectedValidation;
  approvalRequired: boolean;
}

export interface SupplierReplyCandidate {
  supplierId: string;
  poId: string;
  supplierName: string;
  poNumber: string;
}

export interface SupplierReplyCaseV1 {
  caseId: string;
  datasetVersion: typeof SUPPLIER_REPLY_DATASET_VERSION;
  provenance: 'synthetic_contract_case';
  locale: SupplierReplyLocale;
  scenarioTags: string[];
  difficulty: SupplierReplyDifficulty;
  adversarialFlags: string[];
  receivedAt: string;
  body: string;
  candidates: SupplierReplyCandidate[];
  expected: SupplierReplyExpected;
}
