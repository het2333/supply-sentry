/**
 * Deterministic supplier-reply extraction used by both the workflow runtime
 * and the operator review surface. The result is always a suggestion: it does
 * not create a confirmation, mutate a PO, or call a model/connector.
 */

export type SupplierReplyConfidence = 'high' | 'medium' | 'low';
export type SupplierReplyField = 'quantity' | 'unit_price' | 'promised_date';
export type SupplierReplyIntent = 'supplier_reject' | 'delay' | 'confirmation' | 'partial_confirmation' | 'other';

export interface SupplierReplyCommunicationInput {
  id?: string;
  body: string;
  receivedAt?: string;
}

export interface SupplierReplyPoLineInput {
  poLineId: string;
  orderedQty: number;
  poUnitPrice?: number | null;
  requestedAt?: string | null;
  description?: string;
  itemId?: string;
  uom?: string;
}

export interface SupplierReplyFieldSuggestion<T extends string | number> {
  value: T;
  confidence: SupplierReplyConfidence;
  raw: string;
  evidence: string;
  sourceCommunicationId?: string;
  rationale: string;
}

export interface SupplierReplyLineSuggestion {
  poLineId: string;
  quantity?: SupplierReplyFieldSuggestion<number>;
  unitPrice?: SupplierReplyFieldSuggestion<number>;
  promisedDate?: SupplierReplyFieldSuggestion<string>;
}

export interface SupplierReplyConflict {
  code:
    | 'ambiguous_compact_date'
    | 'conflicting_promised_dates'
    | 'conflicting_quantities'
    | 'conflicting_unit_prices'
    | 'ambiguous_line_scope'
    | 'missing_reference_year';
  field: SupplierReplyField;
  message: string;
  raw: string;
  evidence: string;
  sourceCommunicationId?: string;
}

export interface SupplierReplyEvidence {
  field: SupplierReplyField;
  value: string | number | null;
  confidence: SupplierReplyConfidence;
  raw: string;
  evidence: string;
  sourceCommunicationId?: string;
}

export interface SupplierReplyAnalysis {
  strategy: 'deterministic_v1';
  intent: SupplierReplyIntent;
  analyzedText: string;
  quotedSectionRemoved: boolean;
  lineSuggestions: SupplierReplyLineSuggestion[];
  evidence: SupplierReplyEvidence[];
  conflicts: SupplierReplyConflict[];
  missingFields: SupplierReplyField[];
  reliableSuggestionCount: number;
  requiresHumanReview: true;
}

export interface AnalyzeSupplierReplyInput {
  communication: SupplierReplyCommunicationInput;
  earlierCommunications?: SupplierReplyCommunicationInput[];
  poLines?: SupplierReplyPoLineInput[];
  referenceYear?: number;
}

export interface SupplierReplySuggestionValues {
  quantities: Record<string, string>;
  unitPrices: Record<string, string>;
  promisedDates: Record<string, string>;
}

type DateCandidate = {
  value: string | null;
  raw: string;
  index: number;
  confidence: SupplierReplyConfidence;
  kind: 'explicit' | 'compact';
};

type NumberCandidate = {
  value: number;
  raw: string;
  index: number;
  confidence: SupplierReplyConfidence;
  rationale: string;
};

const quotedReplySeparators = [
  /^\s*-{2,}\s*原始邮件\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/i,
  /^\s*_{2,}\s*原始邮件\s*_{2,}\s*$/i,
];

/** Removes only an explicit quoted-mail section, never heuristic body text. */
export function stripQuotedSupplierReply(body: string): { text: string; removed: boolean } {
  const normalized = body.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const separatorIndex = lines.findIndex((line) => quotedReplySeparators.some((pattern) => pattern.test(line)));
  if (separatorIndex < 0) return { text: normalized.trim(), removed: false };
  return { text: lines.slice(0, separatorIndex).join('\n').trim(), removed: true };
}

export function analyzeSupplierReply(input: AnalyzeSupplierReplyInput): SupplierReplyAnalysis {
  const current = stripQuotedSupplierReply(input.communication.body);
  const lines = (input.poLines ?? []).filter((line) => line.poLineId && Number.isFinite(line.orderedQty) && line.orderedQty > 0);
  const referenceYear = validReferenceYear(input.referenceYear)
    ?? yearFromDate(lines.find((line) => line.requestedAt)?.requestedAt)
    ?? yearFromDate(input.communication.receivedAt);
  const conflicts: SupplierReplyConflict[] = [];
  const evidence: SupplierReplyEvidence[] = [];
  const lineSuggestions: SupplierReplyLineSuggestion[] = lines.map((line) => ({ poLineId: line.poLineId }));

  const quantityCandidates = extractQuantityCandidates(current.text, lines);
  const priceCandidates = extractUnitPriceCandidates(current.text);
  const dateCandidates = extractDateCandidates(current.text, referenceYear);

  const quantity = uniqueNumberCandidate(quantityCandidates, 'quantity', conflicts, current.text, input.communication.id);
  const unitPrice = uniqueNumberCandidate(priceCandidates, 'unit_price', conflicts, current.text, input.communication.id);
  const promisedDate = uniqueDateCandidate(dateCandidates, conflicts, current.text, input.communication.id, referenceYear);

  const hasScopedCandidate = Boolean(quantity || unitPrice || promisedDate);
  if (hasScopedCandidate && lines.length !== 1) {
    for (const field of [
      quantity ? 'quantity' : null,
      unitPrice ? 'unit_price' : null,
      promisedDate ? 'promised_date' : null,
    ].filter((field): field is SupplierReplyField => field !== null)) {
      conflicts.push({
        code: 'ambiguous_line_scope',
        field,
        message: lines.length
          ? `回复未明确该${fieldLabel(field)}属于哪一条 PO 行，不会自动分配。`
          : `缺少可校验的 PO 行，不会自动分配${fieldLabel(field)}。`,
        raw: field === 'quantity' ? quantity!.raw : field === 'unit_price' ? unitPrice!.raw : promisedDate!.raw,
        evidence: field === 'quantity'
          ? excerpt(current.text, quantity!.index, quantity!.raw.length)
          : field === 'unit_price'
            ? excerpt(current.text, unitPrice!.index, unitPrice!.raw.length)
            : excerpt(current.text, promisedDate!.index, promisedDate!.raw.length),
        sourceCommunicationId: input.communication.id,
      });
    }
  }

  if (lines.length === 1) {
    const suggestion = lineSuggestions[0]!;
    if (quantity) {
      suggestion.quantity = numberSuggestion(quantity, current.text, input.communication.id);
      evidence.push(fieldEvidence('quantity', quantity, current.text, input.communication.id));
    }
    if (unitPrice) {
      suggestion.unitPrice = numberSuggestion(unitPrice, current.text, input.communication.id);
      evidence.push(fieldEvidence('unit_price', unitPrice, current.text, input.communication.id));
    }
    if (promisedDate?.value) {
      suggestion.promisedDate = {
        value: promisedDate.value,
        confidence: promisedDate.confidence,
        raw: promisedDate.raw,
        evidence: excerpt(current.text, promisedDate.index, promisedDate.raw.length),
        sourceCommunicationId: input.communication.id,
        rationale: '回复中包含明确的月日，年份来自 PO 或通信时间。',
      };
      evidence.push({
        field: 'promised_date', value: promisedDate.value, confidence: promisedDate.confidence,
        raw: promisedDate.raw, evidence: excerpt(current.text, promisedDate.index, promisedDate.raw.length),
        sourceCommunicationId: input.communication.id,
      });
    }
  }

  collectHistoricalConflicts({
    earlierCommunications: input.earlierCommunications ?? [],
    currentDate: promisedDate?.value ?? null,
    currentQuantity: quantity?.value ?? null,
    currentUnitPrice: unitPrice?.value ?? null,
    lines,
    referenceYear,
    conflicts,
  });

  for (const candidate of dateCandidates.filter((item) => item.kind === 'compact')) {
    conflicts.push({
      code: 'ambiguous_compact_date', field: 'promised_date',
      message: `“${candidate.raw}”可能是日期、数量或编号，未自动作为承诺交期。`,
      raw: candidate.raw, evidence: excerpt(current.text, candidate.index, candidate.raw.length),
      sourceCommunicationId: input.communication.id,
    });
  }

  const suggestedFields = new Set<SupplierReplyField>();
  for (const suggestion of lineSuggestions) {
    if (suggestion.quantity) suggestedFields.add('quantity');
    if (suggestion.unitPrice) suggestedFields.add('unit_price');
    if (suggestion.promisedDate) suggestedFields.add('promised_date');
  }
  const missingFields = (['quantity', 'unit_price', 'promised_date'] as const)
    .filter((field) => !suggestedFields.has(field));
  const reliableSuggestionCount = lineSuggestions.reduce((total, suggestion) => total
    + [suggestion.quantity, suggestion.unitPrice, suggestion.promisedDate]
      .filter((item) => item?.confidence === 'high').length, 0);

  const primaryLine = lines.length === 1 ? lines[0] : undefined;
  const intent = supplierReplyIntent(current.text, primaryLine, quantity?.value, promisedDate?.value);
  return {
    strategy: 'deterministic_v1',
    intent,
    analyzedText: current.text,
    quotedSectionRemoved: current.removed,
    lineSuggestions,
    evidence,
    conflicts: deduplicateConflicts(conflicts),
    missingFields,
    reliableSuggestionCount,
    requiresHumanReview: true,
  };
}

/** Returns high-confidence form values only; callers still decide whether to apply them. */
export function buildSupplierReplySuggestionValues(analysis: SupplierReplyAnalysis): SupplierReplySuggestionValues {
  const result: SupplierReplySuggestionValues = { quantities: {}, unitPrices: {}, promisedDates: {} };
  for (const suggestion of analysis.lineSuggestions) {
    if (suggestion.quantity?.confidence === 'high') result.quantities[suggestion.poLineId] = String(suggestion.quantity.value);
    if (suggestion.unitPrice?.confidence === 'high') result.unitPrices[suggestion.poLineId] = String(suggestion.unitPrice.value);
    if (suggestion.promisedDate?.confidence === 'high') result.promisedDates[suggestion.poLineId] = suggestion.promisedDate.value;
  }
  return result;
}

function extractQuantityCandidates(text: string, lines: SupplierReplyPoLineInput[]): NumberCandidate[] {
  const candidates: NumberCandidate[] = [];
  const halfPattern = /(?:只能|只|可以|可|先)?\s*(?:交|发|供|确认)?\s*(?:到|出)?\s*一半/g;
  for (const match of text.matchAll(halfPattern)) {
    if (match.index === undefined || !match[0].trim()) continue;
    if (lines.length === 1) {
      candidates.push({
        value: normalizeDecimal(lines[0]!.orderedQty / 2), raw: match[0].trim(), index: match.index,
        confidence: 'high', rationale: '单行 PO 中“一半”按订购数量的 50% 计算。',
      });
    } else {
      candidates.push({ value: Number.NaN, raw: match[0].trim(), index: match.index, confidence: 'low', rationale: '回复未指定 PO 行。' });
    }
  }
  const explicit = /(?:确认数量|数量|只能交|可以交|可交|能交|先交|交付|供应|确认)\s*(?:为|是|到|：|:)?\s*(\d+(?:\.\d+)?)\s*(件|个|套|台|箱|公斤|千克|kg|吨|units?|ea)/gi;
  for (const match of text.matchAll(explicit)) {
    if (match.index === undefined || !match[1]) continue;
    candidates.push({ value: Number(match[1]), raw: match[0].trim(), index: match.index, confidence: 'high', rationale: '回复明确标记了交付数量和单位。' });
  }
  return candidates.filter((candidate) => Number.isFinite(candidate.value) && candidate.value > 0);
}

function extractUnitPriceCandidates(text: string): NumberCandidate[] {
  const candidates: NumberCandidate[] = [];
  const pattern = /(?:单价|价格|报价)\s*(?:调整为|改为|为|是|：|:)?\s*(?:人民币|rmb|cny|usd|美元|¥|￥|\$)?\s*(\d+(?:\.\d{1,6})?)/gi;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined || !match[1]) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 0) {
      candidates.push({ value, raw: match[0].trim(), index: match.index, confidence: 'high', rationale: '回复使用了明确的单价/价格标记。' });
    }
  }
  return candidates;
}

function extractDateCandidates(text: string, referenceYear: number | null): DateCandidate[] {
  const result: DateCandidate[] = [];
  const occupied: Array<[number, number]> = [];
  const fullPattern = /(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*(?:日|号)?/g;
  for (const match of text.matchAll(fullPattern)) {
    if (match.index === undefined || !match[1] || !match[2] || !match[3]) continue;
    const value = calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (!value) continue;
    result.push({ value, raw: match[0], index: match.index, confidence: 'high', kind: 'explicit' });
    occupied.push([match.index, match.index + match[0].length]);
  }
  const shortPattern = /(\d{1,2})\s*(月|[./])\s*(\d{1,2})\s*(日|号)?/g;
  for (const match of text.matchAll(shortPattern)) {
    if (match.index === undefined || !match[1] || !match[2] || !match[3]) continue;
    const end = match.index + match[0].length;
    if (occupied.some(([start, finish]) => match.index! < finish && end > start)) continue;
    if (!match[4] && !/(交期|日期|改为|改到|延期到|推迟到|要改为|到)\s*$/u.test(text.slice(Math.max(0, match.index - 10), match.index))) continue;
    const value = referenceYear === null ? null : calendarDate(referenceYear, Number(match[1]), Number(match[3]));
    result.push({ value, raw: match[0], index: match.index, confidence: value ? 'high' : 'low', kind: 'explicit' });
  }
  const compactPattern = /(?:交期|日期|改为|改到|延期到|推迟到|要)\s*[：:]?\s*(\d{3,4})(?:日|号)?/g;
  for (const match of text.matchAll(compactPattern)) {
    if (match.index === undefined || !match[1]) continue;
    const rawIndex = match.index + match[0].lastIndexOf(match[1]);
    if (occupied.some(([start, finish]) => rawIndex < finish && rawIndex + match[1]!.length > start)) continue;
    result.push({ value: null, raw: match[1], index: rawIndex, confidence: 'low', kind: 'compact' });
  }
  return result;
}

function uniqueNumberCandidate(
  candidates: NumberCandidate[],
  field: 'quantity' | 'unit_price',
  conflicts: SupplierReplyConflict[],
  text: string,
  sourceCommunicationId?: string,
): NumberCandidate | null {
  const values = [...new Set(candidates.map((candidate) => candidate.value))];
  if (values.length === 1) return candidates.find((candidate) => candidate.value === values[0]) ?? null;
  if (values.length > 1) {
    const raw = candidates.map((candidate) => candidate.raw).join(' / ');
    conflicts.push({
      code: field === 'quantity' ? 'conflicting_quantities' : 'conflicting_unit_prices', field,
      message: `同一封回复中出现多个不同的${fieldLabel(field)}，未自动采用。`,
      raw, evidence: excerpt(text, candidates[0]!.index, candidates.at(-1)!.index + candidates.at(-1)!.raw.length - candidates[0]!.index),
      sourceCommunicationId,
    });
  }
  return null;
}

function uniqueDateCandidate(
  candidates: DateCandidate[],
  conflicts: SupplierReplyConflict[],
  text: string,
  sourceCommunicationId: string | undefined,
  referenceYear: number | null,
): DateCandidate | null {
  const explicit = candidates.filter((candidate) => candidate.kind === 'explicit');
  const values = [...new Set(explicit.map((candidate) => candidate.value).filter((value): value is string => value !== null))];
  if (explicit.some((candidate) => candidate.value === null) && referenceYear === null) {
    const candidate = explicit.find((item) => item.value === null)!;
    conflicts.push({
      code: 'missing_reference_year', field: 'promised_date',
      message: `“${candidate.raw}”缺少可校验的年份，未自动作为承诺交期。`,
      raw: candidate.raw, evidence: excerpt(text, candidate.index, candidate.raw.length), sourceCommunicationId,
    });
  }
  if (values.length === 1) return explicit.find((candidate) => candidate.value === values[0]) ?? null;
  if (values.length > 1) {
    const raw = explicit.map((candidate) => candidate.raw).join(' / ');
    conflicts.push({
      code: 'conflicting_promised_dates', field: 'promised_date',
      message: '同一封回复中出现多个不同的交期，未自动采用。',
      raw, evidence: excerpt(text, explicit[0]!.index, explicit.at(-1)!.index + explicit.at(-1)!.raw.length - explicit[0]!.index),
      sourceCommunicationId,
    });
  }
  return null;
}

function collectHistoricalConflicts(input: {
  earlierCommunications: SupplierReplyCommunicationInput[];
  currentDate: string | null;
  currentQuantity: number | null;
  currentUnitPrice: number | null;
  lines: SupplierReplyPoLineInput[];
  referenceYear: number | null;
  conflicts: SupplierReplyConflict[];
}): void {
  for (const communication of input.earlierCommunications) {
    const stripped = stripQuotedSupplierReply(communication.body);
    const dates = extractDateCandidates(stripped.text, input.referenceYear);
    for (const compact of dates.filter((candidate) => candidate.kind === 'compact')) {
      input.conflicts.push({
        code: 'ambiguous_compact_date', field: 'promised_date',
        message: `较早回复中的“${compact.raw}”可能是日期、数量或编号，未静默忽略，也未自动采用。`,
        raw: compact.raw, evidence: excerpt(stripped.text, compact.index, compact.raw.length), sourceCommunicationId: communication.id,
      });
    }
    const historicalDates = [...new Set(dates.map((candidate) => candidate.value).filter((value): value is string => value !== null))];
    if (input.currentDate && historicalDates.some((date) => date !== input.currentDate)) {
      input.conflicts.push({
        code: 'conflicting_promised_dates', field: 'promised_date',
        message: `较早回复的交期 ${historicalDates.join('、')} 与当前回复 ${input.currentDate} 不一致；当前值只作待人工核对的建议。`,
        raw: historicalDates.join(' / '), evidence: stripped.text.slice(0, 140), sourceCommunicationId: communication.id,
      });
    }
    const quantities = extractQuantityCandidates(stripped.text, input.lines).map((candidate) => candidate.value);
    if (input.currentQuantity !== null && quantities.some((value) => value !== input.currentQuantity)) {
      input.conflicts.push({
        code: 'conflicting_quantities', field: 'quantity',
        message: `较早回复的数量 ${[...new Set(quantities)].join('、')} 与当前建议 ${input.currentQuantity} 不一致。`,
        raw: [...new Set(quantities)].join(' / '), evidence: stripped.text.slice(0, 140), sourceCommunicationId: communication.id,
      });
    }
    const prices = extractUnitPriceCandidates(stripped.text).map((candidate) => candidate.value);
    if (input.currentUnitPrice !== null && prices.some((value) => value !== input.currentUnitPrice)) {
      input.conflicts.push({
        code: 'conflicting_unit_prices', field: 'unit_price',
        message: `较早回复的单价 ${[...new Set(prices)].join('、')} 与当前建议 ${input.currentUnitPrice} 不一致。`,
        raw: [...new Set(prices)].join(' / '), evidence: stripped.text.slice(0, 140), sourceCommunicationId: communication.id,
      });
    }
  }
}

function supplierReplyIntent(
  text: string,
  line: SupplierReplyPoLineInput | undefined,
  quantity: number | undefined,
  promisedDate: string | null | undefined,
): SupplierReplyIntent {
  if (/拒绝|无法接受|无法接单|不能接|不接单/.test(text)) return 'supplier_reject';
  if ((quantity !== undefined && line && quantity < line.orderedQty) || /一半|部分交|分批/.test(text)) return 'partial_confirmation';
  if (/延期|推迟|延后|改期|改为/.test(text) && promisedDate) return 'delay';
  if (quantity !== undefined || promisedDate || /确认|接受|可以交|能交/.test(text)) return 'confirmation';
  return 'other';
}

function numberSuggestion(candidate: NumberCandidate, text: string, sourceCommunicationId?: string): SupplierReplyFieldSuggestion<number> {
  return {
    value: candidate.value, confidence: candidate.confidence, raw: candidate.raw,
    evidence: excerpt(text, candidate.index, candidate.raw.length), sourceCommunicationId,
    rationale: candidate.rationale,
  };
}

function fieldEvidence(field: 'quantity' | 'unit_price', candidate: NumberCandidate, text: string, sourceCommunicationId?: string): SupplierReplyEvidence {
  return {
    field, value: candidate.value, confidence: candidate.confidence, raw: candidate.raw,
    evidence: excerpt(text, candidate.index, candidate.raw.length), sourceCommunicationId,
  };
}

function excerpt(text: string, index: number, length: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const raw = text.slice(Math.max(0, index - 28), Math.min(text.length, index + length + 28)).replace(/\s+/g, ' ').trim();
  return raw || collapsed.slice(0, 120);
}

function fieldLabel(field: SupplierReplyField): string {
  return field === 'quantity' ? '确认数量' : field === 'unit_price' ? '确认单价' : '承诺交期';
}

function normalizeDecimal(value: number): number {
  return Number(value.toFixed(6));
}

function validReferenceYear(value: number | undefined): number | null {
  return value !== undefined && Number.isInteger(value) && value >= 2000 && value <= 2100 ? value : null;
}

function yearFromDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getUTCFullYear();
}

function calendarDate(year: number, month: number, day: number): string | null {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function deduplicateConflicts(conflicts: SupplierReplyConflict[]): SupplierReplyConflict[] {
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const key = `${conflict.code}:${conflict.field}:${conflict.raw}:${conflict.sourceCommunicationId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
