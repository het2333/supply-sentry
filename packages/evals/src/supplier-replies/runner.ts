import { SUPPLIER_REPLY_FIELDS } from './dataset.js';
import {
  SUPPLIER_REPLY_SCHEMA_VERSION,
  type EvidenceSpan,
  type SupplierReplyCaseV1,
  type SupplierReplyExpected,
  type SupplierReplyExtracted,
  type SupplierReplyField,
} from './types.js';

export type SupplierReplyPrediction = SupplierReplyExpected;

export interface SupplierReplyRunMetadata {
  runner: 'deterministic' | 'deepseek';
  model: string;
  promptVersion: string;
  schemaVersion: typeof SUPPLIER_REPLY_SCHEMA_VERSION;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
}

export interface SupplierReplyRunnerOutput {
  prediction: SupplierReplyPrediction;
  metadata: SupplierReplyRunMetadata;
}

export interface SupplierReplyRunner {
  readonly id: 'deterministic' | 'deepseek';
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: typeof SUPPLIER_REPLY_SCHEMA_VERSION;
  run(input: { case: SupplierReplyCaseV1 }): Promise<SupplierReplyRunnerOutput>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function validateSupplierReplyProposal(value: unknown, context: { body: string; candidatePoIds: readonly string[] }): SupplierReplyPrediction {
  if (!isRecord(value) || !isRecord(value['association']) || !isRecord(value['extracted'])) throw new Error('Supplier reply proposal is not an object');
  const association = value['association'];
  const status = association['status'];
  const poId = association['poId'];
  if (!['matched', 'ambiguous', 'unmatched'].includes(String(status))) throw new Error('Supplier reply association is invalid');
  if (status === 'matched' && (typeof poId !== 'string' || !context.candidatePoIds.includes(poId))) throw new Error('Matched supplier reply PO is not a candidate');
  if (status !== 'matched' && poId !== null) throw new Error('Non-matched supplier reply cannot select a PO');

  const extracted = {} as SupplierReplyExtracted;
  for (const field of SUPPLIER_REPLY_FIELDS) {
    const fieldValue = value['extracted'][field];
    if (fieldValue !== null && (typeof fieldValue !== 'string' || !fieldValue.trim())) throw new Error(`Supplier reply field ${field} is invalid`);
    extracted[field] = fieldValue as string | null;
  }
  const unknownFields = value['unknownFields'];
  if (!Array.isArray(unknownFields) || unknownFields.some((field) => !SUPPLIER_REPLY_FIELDS.includes(field as SupplierReplyField))) throw new Error('Supplier reply unknownFields are invalid');
  const unknown = new Set(unknownFields as SupplierReplyField[]);
  if (unknown.size !== unknownFields.length) throw new Error('Supplier reply unknownFields contain duplicates');
  for (const field of SUPPLIER_REPLY_FIELDS) if ((extracted[field] === null) !== unknown.has(field)) throw new Error('Supplier reply unknownFields do not match extracted values');

  if (!Array.isArray(value['evidence'])) throw new Error('Supplier reply evidence is invalid');
  const evidence: EvidenceSpan[] = value['evidence'].map((item, index) => {
    if (!isRecord(item) || !SUPPLIER_REPLY_FIELDS.includes(item['field'] as SupplierReplyField)
      || !Number.isSafeInteger(item['start']) || !Number.isSafeInteger(item['end']) || typeof item['text'] !== 'string') throw new Error(`Supplier reply evidence ${index + 1} is invalid`);
    const span = item as unknown as EvidenceSpan;
    if (span.start < 0 || span.end <= span.start || context.body.slice(span.start, span.end) !== span.text) throw new Error(`Supplier reply evidence ${index + 1} does not match source`);
    if (extracted[span.field] === null) throw new Error(`Supplier reply evidence ${index + 1} supports an unknown field`);
    return { ...span };
  });
  const evidenced = new Set(evidence.map((item) => item.field));
  for (const field of SUPPLIER_REPLY_FIELDS) if (extracted[field] !== null && !evidenced.has(field)) throw new Error(`Supplier reply field ${field} lacks evidence`);

  const validation = value['validation'];
  if (!['accepted', 'review_required', 'rejected'].includes(String(validation))) throw new Error('Supplier reply validation is invalid');
  if (typeof value['approvalRequired'] !== 'boolean') throw new Error('Supplier reply approvalRequired is invalid');
  if (validation === 'accepted' && value['approvalRequired']) throw new Error('Accepted supplier reply cannot require approval');
  return {
    association: { status: status as SupplierReplyPrediction['association']['status'], poId: poId as string | null },
    extracted,
    unknownFields: [...unknown],
    evidence,
    validation: validation as SupplierReplyPrediction['validation'],
    approvalRequired: value['approvalRequired'],
  };
}
