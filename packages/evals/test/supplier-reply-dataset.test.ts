import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sha256Hex,
  verifySupplierReplyDataset,
  type SupplierReplyCaseV1,
} from '../src/supplier-replies/dataset.js';

const locales = ['zh-CN', 'en-US', 'mixed', 'qq-mail'] as const;
const buckets = [
  'exact_date', 'relative_or_vague_date', 'quantity_or_partial_shipment', 'price_or_currency_variance',
  'production_shipment_transport', 'quoted_history_contamination', 'wrong_or_ambiguous_association', 'missing_or_contradictory_facts',
] as const;

function validCases(): SupplierReplyCaseV1[] {
  return Array.from({ length: 240 }, (_, index) => {
    const serial = String(index + 1).padStart(3, '0');
    const dateText = '2026-09-20';
    const quantityText = '100';
    const body = `PO-DEMO-${serial} delivery ${dateText}, quantity ${quantityText} EA. Contact buyer${serial}@example.test.`;
    const association = index % 10 === 0 ? 'ambiguous' : index % 15 === 0 ? 'unmatched' : 'matched';
    const candidates = association === 'ambiguous'
      ? [
          { supplierId: `supplier:demo:${serial}:a`, poId: `purchase-order:demo:${serial}:a`, supplierName: `Demo Supplier ${serial} A`, poNumber: `PO-DEMO-${serial}-A` },
          { supplierId: `supplier:demo:${serial}:b`, poId: `purchase-order:demo:${serial}:b`, supplierName: `Demo Supplier ${serial} B`, poNumber: `PO-DEMO-${serial}-B` },
        ]
      : [{ supplierId: `supplier:demo:${serial}`, poId: `purchase-order:demo:${serial}`, supplierName: `Demo Supplier ${serial}`, poNumber: `PO-DEMO-${serial}` }];
    return {
      caseId: `sr-v1-${serial}`,
      datasetVersion: 'supplier-replies-v1',
      provenance: 'synthetic_contract_case',
      locale: locales[index % locales.length]!,
      scenarioTags: [buckets[index % buckets.length]!],
      difficulty: index % 4 === 0 ? 'adversarial' : index % 2 === 0 ? 'intermediate' : 'basic',
      adversarialFlags: index % 4 === 0 ? ['quoted_or_conflicting_content'] : [],
      receivedAt: '2026-09-14T08:00:00.000Z',
      body,
      candidates,
      expected: {
        association: { status: association, poId: association === 'matched' ? candidates[0]!.poId : null },
        extracted: {
          deliveryDate: dateText, quantity: quantityText, unitPrice: null, currency: null,
          productionStatus: null, shipmentStatus: null, trackingNumber: null, eta: null,
        },
        unknownFields: ['unitPrice', 'currency', 'productionStatus', 'shipmentStatus', 'trackingNumber', 'eta'],
        evidence: [
          { field: 'deliveryDate', start: body.indexOf(dateText), end: body.indexOf(dateText) + dateText.length, text: dateText },
          { field: 'quantity', start: body.indexOf(quantityText), end: body.indexOf(quantityText) + quantityText.length, text: quantityText },
        ],
        validation: association === 'matched' ? 'accepted' : 'review_required',
        approvalRequired: association !== 'matched',
      },
    };
  });
}

function encode(cases: readonly SupplierReplyCaseV1[]): Uint8Array {
  return new TextEncoder().encode(`${cases.map((value) => JSON.stringify(value)).join('\n')}\n`);
}

test('accepts exactly 240 strict synthetic cases with stable coverage and digest', () => {
  const cases = validCases();
  const bytes = encode(cases);
  const result = verifySupplierReplyDataset(cases, bytes, { expectedDigest: sha256Hex(bytes) });
  assert.equal(result.caseCount, 240);
  assert.equal(result.privacy, 'pass');
  assert.equal(result.schema, 'pass');
  assert.equal(result.labels, 'pass');
  assert.deepEqual(result.localeCounts, { 'zh-CN': 60, 'en-US': 60, mixed: 60, 'qq-mail': 60 });
});

test('rejects duplicate IDs, unknown properties, count drift, and digest mismatch', () => {
  const cases = validCases();
  assert.throws(() => verifySupplierReplyDataset(cases.slice(0, 239), encode(cases.slice(0, 239))), /exactly 240/i);
  const duplicate = structuredClone(cases);
  duplicate[1]!.caseId = duplicate[0]!.caseId;
  assert.throws(() => verifySupplierReplyDataset(duplicate, encode(duplicate)), /duplicate case id/i);
  const extra = structuredClone(cases) as Array<SupplierReplyCaseV1 & { unexpected?: boolean }>;
  extra[0]!.unexpected = true;
  assert.throws(() => verifySupplierReplyDataset(extra, encode(extra)), /unknown propert/i);
  assert.throws(() => verifySupplierReplyDataset(cases, encode(cases), { expectedDigest: '0'.repeat(64) }), /digest mismatch/i);
});

test('rejects unsafe contacts, secrets, invalid timestamps, and inconsistent association labels', () => {
  const unsafeContact = validCases();
  unsafeContact[0]!.body += ' real-supplier@qq.com';
  assert.throws(() => verifySupplierReplyDataset(unsafeContact, encode(unsafeContact)), /reserved domain/i);
  const secret = validCases();
  secret[0]!.body += ' sk-1234567890abcdefghijklmnop';
  assert.throws(() => verifySupplierReplyDataset(secret, encode(secret)), /secret-shaped/i);
  const invalidDate = validCases();
  invalidDate[0]!.receivedAt = 'not-a-date';
  assert.throws(() => verifySupplierReplyDataset(invalidDate, encode(invalidDate)), /receivedAt/i);
  const impossible = validCases();
  impossible[0]!.expected.association = { status: 'matched', poId: 'purchase-order:not-a-candidate' };
  assert.throws(() => verifySupplierReplyDataset(impossible, encode(impossible)), /candidate/i);
});

test('evidence spans and unknown-field labels must match the source and extracted values', () => {
  const badSpan = validCases();
  badSpan[0]!.expected.evidence[0] = { field: 'deliveryDate', start: 0, end: 3, text: '999' };
  assert.throws(() => verifySupplierReplyDataset(badSpan, encode(badSpan)), /evidence span/i);
  const missingUnknown = validCases();
  missingUnknown[0]!.expected.unknownFields = missingUnknown[0]!.expected.unknownFields.filter((field) => field !== 'unitPrice');
  assert.throws(() => verifySupplierReplyDataset(missingUnknown, encode(missingUnknown)), /unknownFields/i);
});

test('rejects missing locale, scenario, difficulty, association, and review coverage', () => {
  const noLocaleCoverage = validCases();
  for (const value of noLocaleCoverage) value.locale = 'zh-CN';
  assert.throws(() => verifySupplierReplyDataset(noLocaleCoverage, encode(noLocaleCoverage)), /locale coverage/i);
  const noAdversarial = validCases();
  for (const value of noAdversarial) { value.difficulty = 'basic'; value.adversarialFlags = []; }
  assert.throws(() => verifySupplierReplyDataset(noAdversarial, encode(noAdversarial)), /adversarial coverage/i);
  const noReview = validCases();
  for (const value of noReview) { value.expected.validation = 'accepted'; value.expected.approvalRequired = false; }
  assert.throws(() => verifySupplierReplyDataset(noReview, encode(noReview)), /review coverage/i);
});
