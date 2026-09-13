import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  SUPPLIER_REPLY_DATASET_VERSION,
  type SupplierReplyCaseV1,
  type SupplierReplyField,
} from './types.js';

export type { SupplierReplyCaseV1 } from './types.js';

const ROOT_KEYS = ['caseId', 'datasetVersion', 'provenance', 'locale', 'scenarioTags', 'difficulty', 'adversarialFlags', 'receivedAt', 'body', 'candidates', 'expected'] as const;
const CANDIDATE_KEYS = ['supplierId', 'poId', 'supplierName', 'poNumber'] as const;
const EXPECTED_KEYS = ['association', 'extracted', 'unknownFields', 'evidence', 'validation', 'approvalRequired'] as const;
const ASSOCIATION_KEYS = ['status', 'poId'] as const;
const EVIDENCE_KEYS = ['field', 'start', 'end', 'text'] as const;
export const SUPPLIER_REPLY_FIELDS = ['deliveryDate', 'quantity', 'unitPrice', 'currency', 'productionStatus', 'shipmentStatus', 'trackingNumber', 'eta'] as const satisfies readonly SupplierReplyField[];
export const PRIMARY_SCENARIO_BUCKETS = [
  'exact_date', 'relative_or_vague_date', 'quantity_or_partial_shipment', 'price_or_currency_variance',
  'production_shipment_transport', 'quoted_history_contamination', 'wrong_or_ambiguous_association', 'missing_or_contradictory_facts',
] as const;

export interface DatasetVerification {
  caseCount: number;
  digest: string;
  privacy: 'pass';
  schema: 'pass';
  labels: 'pass';
  localeCounts: Record<string, number>;
  difficultyCounts: Record<string, number>;
  associationCounts: Record<string, number>;
  validationCounts: Record<string, number>;
  scenarioCounts: Record<string, number>;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: expected object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, allowed: readonly string[], where: string): Record<string, unknown> {
  const object = record(value, where);
  const extras = Object.keys(object).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in object));
  if (extras.length > 0) throw new Error(`${where}: unknown properties ${extras.join(', ')}`);
  if (missing.length > 0) throw new Error(`${where}: missing properties ${missing.join(', ')}`);
  return object;
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function validTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validateCase(value: SupplierReplyCaseV1, index: number): void {
  const where = `case ${index + 1}`;
  exactKeys(value, ROOT_KEYS, where);
  if (!/^sr-v1-\d{3}$/u.test(value.caseId)) throw new Error(`${where}: invalid caseId`);
  if (value.datasetVersion !== SUPPLIER_REPLY_DATASET_VERSION) throw new Error(`${where}: invalid datasetVersion`);
  if (value.provenance !== 'synthetic_contract_case') throw new Error(`${where}: invalid provenance`);
  if (!['zh-CN', 'en-US', 'mixed', 'qq-mail'].includes(value.locale)) throw new Error(`${where}: invalid locale`);
  if (!['basic', 'intermediate', 'adversarial'].includes(value.difficulty)) throw new Error(`${where}: invalid difficulty`);
  if (!validTimestamp(value.receivedAt)) throw new Error(`${where}: receivedAt must be RFC 3339 with milliseconds`);
  if (typeof value.body !== 'string' || value.body.trim().length === 0) throw new Error(`${where}: body is required`);
  if (!Array.isArray(value.scenarioTags) || value.scenarioTags.length === 0 || value.scenarioTags.some((tag) => typeof tag !== 'string' || !tag)) throw new Error(`${where}: scenarioTags are invalid`);
  if (!Array.isArray(value.adversarialFlags) || value.adversarialFlags.some((flag) => typeof flag !== 'string' || !flag)) throw new Error(`${where}: adversarialFlags are invalid`);
  if (value.difficulty === 'adversarial' && value.adversarialFlags.length === 0) throw new Error(`${where}: adversarial cases require flags`);

  if (/sk-[A-Za-z0-9]{16,}|BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/iu.test(value.body)) throw new Error(`${where}: secret-shaped content is forbidden`);
  for (const email of value.body.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/giu) ?? []) {
    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
    if (!['example.com', 'example.net', 'example.org', 'example.test'].includes(domain)) throw new Error(`${where}: contacts must use a reserved domain`);
  }

  if (!Array.isArray(value.candidates) || value.candidates.length === 0) throw new Error(`${where}: candidates are required`);
  for (const [candidateIndex, candidate] of value.candidates.entries()) {
    const candidateRecord = exactKeys(candidate, CANDIDATE_KEYS, `${where} candidate ${candidateIndex + 1}`);
    if (Object.values(candidateRecord).some((item) => typeof item !== 'string' || !item)) throw new Error(`${where}: candidate strings are required`);
  }

  exactKeys(value.expected, EXPECTED_KEYS, `${where} expected`);
  exactKeys(value.expected.association, ASSOCIATION_KEYS, `${where} association`);
  exactKeys(value.expected.extracted, SUPPLIER_REPLY_FIELDS, `${where} extracted`);
  if (!['matched', 'ambiguous', 'unmatched'].includes(value.expected.association.status)) throw new Error(`${where}: invalid association`);
  const matchedPo = value.expected.association.poId;
  if (value.expected.association.status === 'matched') {
    if (!matchedPo || !value.candidates.some((candidate) => candidate.poId === matchedPo)) throw new Error(`${where}: matched PO must be a candidate`);
  } else if (matchedPo !== null) throw new Error(`${where}: non-matched association cannot name a PO`);
  if (!['accepted', 'review_required', 'rejected'].includes(value.expected.validation)) throw new Error(`${where}: invalid validation`);
  if (typeof value.expected.approvalRequired !== 'boolean') throw new Error(`${where}: approvalRequired must be boolean`);
  if (value.expected.validation === 'accepted' && value.expected.approvalRequired) throw new Error(`${where}: accepted result cannot require approval`);

  if (!Array.isArray(value.expected.unknownFields) || value.expected.unknownFields.some((field) => !SUPPLIER_REPLY_FIELDS.includes(field))) throw new Error(`${where}: unknownFields contains an invalid field`);
  const unknown = new Set(value.expected.unknownFields);
  if (unknown.size !== value.expected.unknownFields.length) throw new Error(`${where}: unknownFields contains duplicates`);
  for (const field of SUPPLIER_REPLY_FIELDS) {
    const extracted = value.expected.extracted[field];
    if (extracted !== null && (typeof extracted !== 'string' || !extracted)) throw new Error(`${where}: extracted ${field} is invalid`);
    if ((extracted === null) !== unknown.has(field)) throw new Error(`${where}: unknownFields must exactly match null extracted fields`);
  }

  if (!Array.isArray(value.expected.evidence)) throw new Error(`${where}: evidence must be an array`);
  const evidenceFields = new Set<string>();
  for (const [evidenceIndex, evidence] of value.expected.evidence.entries()) {
    exactKeys(evidence, EVIDENCE_KEYS, `${where} evidence ${evidenceIndex + 1}`);
    if (!SUPPLIER_REPLY_FIELDS.includes(evidence.field)) throw new Error(`${where}: invalid evidence field`);
    if (!Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) || evidence.start < 0 || evidence.end <= evidence.start || evidence.end > value.body.length) throw new Error(`${where}: evidence span bounds are invalid`);
    if (value.body.slice(evidence.start, evidence.end) !== evidence.text) throw new Error(`${where}: evidence span does not match body`);
    if (value.expected.extracted[evidence.field] === null) throw new Error(`${where}: evidence cannot support an unknown field`);
    evidenceFields.add(evidence.field);
  }
  for (const field of SUPPLIER_REPLY_FIELDS) if (value.expected.extracted[field] !== null && !evidenceFields.has(field)) throw new Error(`${where}: extracted ${field} lacks evidence span`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifySupplierReplyDataset(
  cases: readonly SupplierReplyCaseV1[],
  sourceBytes: Uint8Array,
  options: { expectedDigest?: string } = {},
): DatasetVerification {
  if (cases.length !== 240) throw new Error(`dataset must contain exactly 240 cases; received ${cases.length}`);
  const ids = new Set<string>();
  cases.forEach((value, index) => {
    validateCase(value, index);
    if (ids.has(value.caseId)) throw new Error(`duplicate case id: ${value.caseId}`);
    ids.add(value.caseId);
  });
  const digest = sha256Hex(sourceBytes);
  if (options.expectedDigest && digest !== options.expectedDigest.trim()) throw new Error(`dataset digest mismatch: expected ${options.expectedDigest.trim()}, received ${digest}`);

  const localeCounts = countBy(cases.map((value) => value.locale));
  for (const locale of ['zh-CN', 'en-US', 'mixed', 'qq-mail']) if ((localeCounts[locale] ?? 0) === 0) throw new Error(`locale coverage missing: ${locale}`);
  const difficultyCounts = countBy(cases.map((value) => value.difficulty));
  if ((difficultyCounts.adversarial ?? 0) < 60) throw new Error('adversarial coverage must include at least 60 cases');
  const associationCounts = countBy(cases.map((value) => value.expected.association.status));
  for (const label of ['matched', 'ambiguous', 'unmatched']) if ((associationCounts[label] ?? 0) === 0) throw new Error(`association coverage missing: ${label}`);
  const validationCounts = countBy(cases.map((value) => value.expected.validation));
  if ((validationCounts.review_required ?? 0) === 0 || (validationCounts.accepted ?? 0) === 0) throw new Error('review coverage must include accepted and review_required cases');
  const scenarioCounts = countBy(cases.flatMap((value) => value.scenarioTags));
  for (const bucket of PRIMARY_SCENARIO_BUCKETS) if ((scenarioCounts[bucket] ?? 0) === 0) throw new Error(`scenario coverage missing: ${bucket}`);
  return { caseCount: cases.length, digest, privacy: 'pass', schema: 'pass', labels: 'pass', localeCounts, difficultyCounts, associationCounts, validationCounts, scenarioCounts };
}

export async function loadSupplierReplyDataset(path: string): Promise<{ cases: SupplierReplyCaseV1[]; sourceBytes: Uint8Array }> {
  const sourceBytes = await readFile(path);
  const text = sourceBytes.toString('utf8');
  const cases: SupplierReplyCaseV1[] = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try { cases.push(JSON.parse(line) as SupplierReplyCaseV1); }
    catch { throw new Error(`dataset line ${index + 1}: invalid JSON`); }
  }
  return { cases, sourceBytes };
}
