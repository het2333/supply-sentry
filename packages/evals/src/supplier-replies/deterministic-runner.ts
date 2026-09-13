import { SUPPLIER_REPLY_FIELDS } from './dataset.js';
import { validateSupplierReplyProposal, type SupplierReplyPrediction, type SupplierReplyRunner } from './runner.js';
import type { EvidenceSpan, SupplierReplyCaseV1, SupplierReplyExtracted, SupplierReplyField } from './types.js';

type TextView = { text: string; offset: number };

function currentReply(body: string): TextView {
  const markers = ['-----最新回复-----\n', 'Latest reply: ', '最新回复：', '最新确认 '];
  let selected = { text: body, offset: 0 };
  for (const marker of markers) {
    const position = body.lastIndexOf(marker);
    if (position >= 0 && position + marker.length > selected.offset) selected = { text: body.slice(position + marker.length), offset: position + marker.length };
  }
  return selected;
}

function addFact(
  body: string,
  extracted: SupplierReplyExtracted,
  evidence: EvidenceSpan[],
  field: SupplierReplyField,
  value: string,
  text: string,
  preferredOffset = 0,
): void {
  const start = body.indexOf(text, preferredOffset);
  if (start < 0) return;
  extracted[field] = value;
  evidence.push({ field, start, end: start + text.length, text });
}

function matchFirst(text: string, patterns: readonly RegExp[]): RegExpExecArray | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

function addMatchedGroup(body: string, view: TextView, extracted: SupplierReplyExtracted, evidence: EvidenceSpan[], field: SupplierReplyField, match: RegExpExecArray | null, value?: string): void {
  const text = match?.[1];
  if (!text) return;
  addFact(body, extracted, evidence, field, value ?? text, text, view.offset + (match?.index ?? 0));
}

function associationFor(value: SupplierReplyCaseV1): SupplierReplyPrediction['association'] {
  const matches = value.candidates.filter((candidate) => value.body.includes(candidate.poNumber));
  if (matches.length === 1) return { status: 'matched', poId: matches[0]!.poId };
  if (matches.length > 1) return { status: 'ambiguous', poId: null };
  return { status: 'unmatched', poId: null };
}

function parse(value: SupplierReplyCaseV1): SupplierReplyPrediction {
  const view = currentReply(value.body);
  const extracted: SupplierReplyExtracted = {
    deliveryDate: null, quantity: null, unitPrice: null, currency: null,
    productionStatus: null, shipmentStatus: null, trackingNumber: null, eta: null,
  };
  const evidence: EvidenceSpan[] = [];
  const association = associationFor(value);

  const eta = /\bETA\s+(\d{4}-\d{2}-\d{2})/iu.exec(view.text);
  if (eta) addMatchedGroup(value.body, view, extracted, evidence, 'eta', eta);
  const dates = [...view.text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/gu)];
  if (!eta && dates.length === 1) addMatchedGroup(value.body, view, extracted, evidence, 'deliveryDate', dates[0]!);
  if (!eta && dates.length === 0) {
    const relative = /(tomorrow|明天)/iu.exec(view.text);
    if (relative) {
      const received = new Date(value.receivedAt);
      received.setUTCDate(received.getUTCDate() + 1);
      addMatchedGroup(value.body, view, extracted, evidence, 'deliveryDate', relative, received.toISOString().slice(0, 10));
    }
  }

  const quantity = matchFirst(view.text, [
    /(?:只能确认|currently\s+confirm|目前\s*confirm)\s*(\d+(?:\.\d+)?)/iu,
    /(?:confirm\s+only|can\s+confirm\s+only)\s*(\d+(?:\.\d+)?)/iu,
    /(?:final quantity|最终数量)\s*(\d+(?:\.\d+)?)/iu,
    /(?:数量(?:\s*qty)?|quantity|qty)\s*(\d+(?:\.\d+)?)/iu,
  ]);
  addMatchedGroup(value.body, view, extracted, evidence, 'quantity', quantity);

  const unitPrice = /CNY\s+(\d+(?:\.\d+)?)/iu.exec(view.text);
  if (unitPrice) {
    addMatchedGroup(value.body, view, extracted, evidence, 'unitPrice', unitPrice);
    const currency = /\b(CNY)\b/u.exec(view.text);
    addMatchedGroup(value.body, view, extracted, evidence, 'currency', currency);
  }

  const production = /(production completed|生产完成)/iu.exec(view.text);
  if (production) addMatchedGroup(value.body, view, extracted, evidence, 'productionStatus', production, 'completed');
  const tracking = /\b(DEMO-TRK-\d{3})\b/u.exec(view.text);
  addMatchedGroup(value.body, view, extracted, evidence, 'trackingNumber', tracking);
  const partial = /(partial shipment|分批发货)/iu.exec(view.text);
  const notShipped = /(not shipped|尚未发货)/iu.exec(view.text);
  const shipped = /(?<!not )(shipped)|(已发货)/iu.exec(view.text);
  if (partial) addMatchedGroup(value.body, view, extracted, evidence, 'shipmentStatus', partial, 'partial_planned');
  else if (notShipped) addMatchedGroup(value.body, view, extracted, evidence, 'shipmentStatus', notShipped, 'not_shipped');
  else if (shipped) {
    const supported = shipped[1] ?? shipped[2];
    if (supported) addFact(value.body, extracted, evidence, 'shipmentStatus', 'shipped', supported, view.offset + shipped.index);
  }

  const reviewRequired = association.status !== 'matched'
    || Boolean(partial || unitPrice || notShipped)
    || dates.length > 1
    || /(next week|下周左右|ambiguous|信息不足|信息不够|不是候选订单|not a candidate)/iu.test(view.text);
  const prediction: SupplierReplyPrediction = {
    association,
    extracted,
    unknownFields: SUPPLIER_REPLY_FIELDS.filter((field) => extracted[field] === null),
    evidence: evidence.sort((a, b) => a.start - b.start || a.field.localeCompare(b.field)),
    validation: reviewRequired ? 'review_required' : 'accepted',
    approvalRequired: reviewRequired,
  };
  return validateSupplierReplyProposal(prediction, { body: value.body, candidatePoIds: value.candidates.map((candidate) => candidate.poId) });
}

export function createDeterministicSupplierReplyRunner(): SupplierReplyRunner {
  return {
    id: 'deterministic',
    model: 'supplysentry-deterministic-v1',
    promptVersion: 'deterministic-patterns-v1',
    schemaVersion: 'supplier-reply-proposal-v1',
    async run(input) {
      const started = performance.now();
      const prediction = parse(input.case);
      return {
        prediction,
        metadata: {
          runner: 'deterministic', model: this.model, promptVersion: this.promptVersion, schemaVersion: this.schemaVersion,
          latencyMs: Math.max(0, performance.now() - started), inputTokens: null, outputTokens: null, cost: null,
        },
      };
    },
  };
}
