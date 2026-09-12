import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeSupplierReply,
  buildSupplierReplySuggestionValues,
  stripQuotedSupplierReply,
} from '@readywork/core';

const p00021Line = {
  poLineId: 'purchase-order-line:odoo:21:1',
  orderedQty: 300,
  poUnitPrice: 80,
  requestedAt: '2026-08-09T16:00:00.000Z',
  description: '过滤器 FL-40',
  uom: 'Units',
};

describe('deterministic supplier reply analysis', () => {
  it('turns the latest real P00021 wording into reviewable quantity/date suggestions without inventing price', () => {
    const analysis = analyzeSupplierReply({
      communication: { id: 'communication:new', body: '要改为8.10号了，只能交一半', receivedAt: '2026-08-30T08:00:00.000Z' },
      earlierCommunications: [{ id: 'communication:old', body: '要823，只能交一半', receivedAt: '2026-08-29T08:00:00.000Z' }],
      poLines: [p00021Line],
    });

    assert.equal(analysis.intent, 'partial_confirmation');
    assert.equal(analysis.strategy, 'deterministic_v1');
    assert.equal(analysis.lineSuggestions[0]?.quantity?.value, 150);
    assert.equal(analysis.lineSuggestions[0]?.promisedDate?.value, '2026-08-10');
    assert.equal(analysis.lineSuggestions[0]?.unitPrice, undefined);
    assert.deepEqual(analysis.missingFields, ['unit_price']);
    assert.equal(analysis.reliableSuggestionCount, 2);
    assert.equal(analysis.requiresHumanReview, true);
    assert.ok(analysis.conflicts.some((conflict) => conflict.code === 'ambiguous_compact_date' && conflict.raw === '823'));
    assert.deepEqual(buildSupplierReplySuggestionValues(analysis), {
      quantities: { 'purchase-order-line:odoo:21:1': '150' },
      unitPrices: {},
      promisedDates: { 'purchase-order-line:odoo:21:1': '2026-08-10' },
    });
  });

  it('removes an explicitly quoted original mail so old PO values cannot become current supplier facts', () => {
    const body = [
      '可以交 80 件，交期改为 9月18日',
      '',
      '------------------ 原始邮件 ------------------',
      '原 PO：100 件，单价 12，交期 2026-09-15',
    ].join('\n');
    assert.deepEqual(stripQuotedSupplierReply(body), {
      text: '可以交 80 件，交期改为 9月18日',
      removed: true,
    });
    const analysis = analyzeSupplierReply({ communication: { body }, poLines: [{ ...p00021Line, orderedQty: 100 }] });
    assert.equal(analysis.quotedSectionRemoved, true);
    assert.equal(analysis.lineSuggestions[0]?.quantity?.value, 80);
    assert.equal(analysis.lineSuggestions[0]?.promisedDate?.value, '2026-09-18');
    assert.equal(analysis.lineSuggestions[0]?.unitPrice, undefined);
  });

  it('does not allocate a reply-level number across multiple PO lines', () => {
    const analysis = analyzeSupplierReply({
      communication: { body: '只能交 80 件，交期改为 9月18日' },
      referenceYear: 2026,
      poLines: [p00021Line, { ...p00021Line, poLineId: 'line:2', orderedQty: 20 }],
    });
    assert.equal(analysis.lineSuggestions.every((line) => !line.quantity && !line.promisedDate), true);
    assert.ok(analysis.conflicts.some((conflict) => conflict.code === 'ambiguous_line_scope' && conflict.field === 'quantity'));
    assert.ok(analysis.conflicts.some((conflict) => conflict.code === 'ambiguous_line_scope' && conflict.field === 'promised_date'));
  });

  it('keeps multiple values in one message unresolved instead of selecting the first match', () => {
    const analysis = analyzeSupplierReply({
      communication: { body: '数量 80 件，后面又说数量 90 件；交期 2026-09-18 或交期 2026-09-20' },
      poLines: [p00021Line],
    });
    assert.equal(analysis.lineSuggestions[0]?.quantity, undefined);
    assert.equal(analysis.lineSuggestions[0]?.promisedDate, undefined);
    assert.ok(analysis.conflicts.some((conflict) => conflict.code === 'conflicting_quantities'));
    assert.ok(analysis.conflicts.some((conflict) => conflict.code === 'conflicting_promised_dates'));
  });

  it('requires a reference year before converting a month/day reply', () => {
    const analysis = analyzeSupplierReply({ communication: { body: '交期改为 9月18日' } });
    assert.equal(analysis.lineSuggestions.length, 0);
    assert.ok(analysis.conflicts.some((conflict) => conflict.code === 'missing_reference_year'));
  });

  it('fills only high-confidence extracted values and never substitutes the PO baseline', () => {
    const analysis = analyzeSupplierReply({
      communication: { body: '确认数量 300 Units，单价 CNY 80，交期 2026-08-10' },
      poLines: [p00021Line],
    });
    assert.deepEqual(buildSupplierReplySuggestionValues(analysis), {
      quantities: { 'purchase-order-line:odoo:21:1': '300' },
      unitPrices: { 'purchase-order-line:odoo:21:1': '80' },
      promisedDates: { 'purchase-order-line:odoo:21:1': '2026-08-10' },
    });
  });
});
