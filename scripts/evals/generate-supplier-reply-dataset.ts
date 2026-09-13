import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PRIMARY_SCENARIO_BUCKETS,
  sha256Hex,
  type SupplierReplyCaseV1,
} from '../../packages/evals/src/supplier-replies/dataset.js';
import type {
  EvidenceSpan,
  SupplierReplyExtracted,
  SupplierReplyField,
  SupplierReplyLocale,
} from '../../packages/evals/src/supplier-replies/types.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const datasetPath = resolve(repositoryRoot, 'evals/supplier-replies/v1/dataset.jsonl');
const digestPath = resolve(repositoryRoot, 'evals/supplier-replies/v1/dataset.sha256');
const locales = ['zh-CN', 'en-US', 'mixed', 'qq-mail'] as const satisfies readonly SupplierReplyLocale[];

type Fact = { value: string; evidence: string };
type Scenario = {
  body: string;
  facts?: Partial<Record<SupplierReplyField, Fact>>;
  association?: 'matched' | 'ambiguous' | 'unmatched';
  validation?: 'accepted' | 'review_required' | 'rejected';
  approvalRequired?: boolean;
  candidates?: 1 | 2;
};

function emptyExtracted(): SupplierReplyExtracted {
  return {
    deliveryDate: null, quantity: null, unitPrice: null, currency: null,
    productionStatus: null, shipmentStatus: null, trackingNumber: null, eta: null,
  };
}

function localized(locale: SupplierReplyLocale, variants: { zh: string; en: string; mixed: string; qq: string }): string {
  if (locale === 'zh-CN') return variants.zh;
  if (locale === 'en-US') return variants.en;
  if (locale === 'mixed') return variants.mixed;
  return `发件人: demo.sender@example.test\n时间: 2026年9月14日 16:00\n主题: Re: 交期确认\n\n${variants.qq}`;
}

function scenario(bucket: string, ordinal: number, locale: SupplierReplyLocale, poNumber: string): Scenario {
  const quantity = String(100 + ordinal * 10);
  const exactDate = `2026-09-${String(18 + (ordinal % 8)).padStart(2, '0')}`;
  if (bucket === 'exact_date') {
    return {
      body: localized(locale, {
        zh: `${poNumber} 已确认，交期 ${exactDate}，数量 ${quantity} 件。联系人 demo.sender@example.test。`,
        en: `${poNumber} confirmed. Delivery ${exactDate}, quantity ${quantity} EA. Contact demo.sender@example.test.`,
        mixed: `${poNumber} 已确认 / confirmed，delivery ${exactDate}，数量 qty ${quantity} EA。demo.sender@example.test`,
        qq: `${poNumber} 已确认，交期 ${exactDate}，数量 ${quantity} 件。`,
      }),
      facts: { deliveryDate: { value: exactDate, evidence: exactDate }, quantity: { value: quantity, evidence: quantity } },
    };
  }
  if (bucket === 'relative_or_vague_date') {
    const vague = ordinal % 2 === 1;
    const evidence = locale === 'en-US' ? (vague ? 'next week' : 'tomorrow') : vague ? '下周左右' : '明天';
    return {
      body: localized(locale, {
        zh: `${poNumber} 数量 ${quantity} 件已排产，预计${evidence}可以交货。demo.sender@example.test`,
        en: `${poNumber}, quantity ${quantity} EA, is scheduled. Delivery is expected ${evidence}. demo.sender@example.test`,
        mixed: `${poNumber} qty ${quantity} EA 已排产，delivery ${evidence}。demo.sender@example.test`,
        qq: `${poNumber} 数量 ${quantity} 件，预计${evidence}交货。`,
      }),
      facts: {
        quantity: { value: quantity, evidence: quantity },
        ...(vague ? {} : { deliveryDate: { value: '2026-09-15', evidence } }),
      },
      validation: vague ? 'review_required' : 'accepted',
      approvalRequired: vague,
    };
  }
  if (bucket === 'quantity_or_partial_shipment') {
    const ordered = String(Number(quantity) + 600);
    const partial = locale === 'en-US' ? 'partial shipment' : '分批发货';
    return {
      body: localized(locale, {
        zh: `${poNumber} 原数量 ${ordered} 件，目前只能确认 ${quantity} 件，将${partial}，交期 ${exactDate}。demo.sender@example.test`,
        en: `${poNumber}: ordered ${ordered} EA; we can confirm only ${quantity} EA as a ${partial}, delivery ${exactDate}. demo.sender@example.test`,
        mixed: `${poNumber} ordered ${ordered} EA，目前 confirm ${quantity} EA，${partial}，delivery ${exactDate}。demo.sender@example.test`,
        qq: `${poNumber} 原数量 ${ordered} 件，只能确认 ${quantity} 件，${partial}，交期 ${exactDate}。`,
      }),
      facts: {
        quantity: { value: quantity, evidence: quantity }, deliveryDate: { value: exactDate, evidence: exactDate },
        shipmentStatus: { value: 'partial_planned', evidence: partial },
      },
      validation: 'review_required', approvalRequired: true,
    };
  }
  if (bucket === 'price_or_currency_variance') {
    const price = (18 + ordinal / 100).toFixed(2);
    return {
      body: localized(locale, {
        zh: `${poNumber} 数量 ${quantity} 件，最新单价调整为 CNY ${price}，请确认价格变更。demo.sender@example.test`,
        en: `${poNumber}, quantity ${quantity} EA. Revised unit price is CNY ${price}; please approve the variance. demo.sender@example.test`,
        mixed: `${poNumber} qty ${quantity} EA，new unit price CNY ${price}，请确认 variance。demo.sender@example.test`,
        qq: `${poNumber} 数量 ${quantity} 件，单价改为 CNY ${price}，请确认。`,
      }),
      facts: {
        quantity: { value: quantity, evidence: quantity }, unitPrice: { value: price, evidence: price }, currency: { value: 'CNY', evidence: 'CNY' },
      },
      validation: 'review_required', approvalRequired: true,
    };
  }
  if (bucket === 'production_shipment_transport') {
    const tracking = `DEMO-TRK-${String(ordinal).padStart(3, '0')}`;
    const production = locale === 'en-US' ? 'production completed' : '生产完成';
    const shipped = locale === 'en-US' ? 'shipped' : '已发货';
    return {
      body: localized(locale, {
        zh: `${poNumber} ${production}并${shipped}，运单号 ${tracking}，ETA ${exactDate}。demo.sender@example.test`,
        en: `${poNumber}: ${production} and ${shipped}. Tracking ${tracking}; ETA ${exactDate}. demo.sender@example.test`,
        mixed: `${poNumber} ${production}, status ${shipped}, tracking ${tracking}, ETA ${exactDate}。demo.sender@example.test`,
        qq: `${poNumber} ${production}，${shipped}，运单号 ${tracking}，ETA ${exactDate}。`,
      }),
      facts: {
        productionStatus: { value: 'completed', evidence: production }, shipmentStatus: { value: 'shipped', evidence: shipped },
        trackingNumber: { value: tracking, evidence: tracking }, eta: { value: exactDate, evidence: exactDate },
      },
    };
  }
  if (bucket === 'quoted_history_contamination') {
    const oldDate = '2025-01-03';
    const newQuantity = String(Number(quantity) + 3);
    return {
      body: localized(locale, {
        zh: `历史引用> ${poNumber} 旧交期 ${oldDate}，旧数量 9 件。\n最新回复：${poNumber} 最终交期 ${exactDate}，最终数量 ${newQuantity} 件。demo.sender@example.test`,
        en: `Quoted history> ${poNumber} old delivery ${oldDate}, old quantity 9 EA.\nLatest reply: ${poNumber} final delivery ${exactDate}, final quantity ${newQuantity} EA. demo.sender@example.test`,
        mixed: `Quoted> ${poNumber} old ${oldDate}, qty 9.\n最新确认 final delivery ${exactDate}, qty ${newQuantity} EA. demo.sender@example.test`,
        qq: `-----原始邮件-----\n${poNumber} 旧交期 ${oldDate}，旧数量 9 件。\n-----最新回复-----\n最终交期 ${exactDate}，最终数量 ${newQuantity} 件。`,
      }),
      facts: { deliveryDate: { value: exactDate, evidence: exactDate }, quantity: { value: newQuantity, evidence: newQuantity } },
    };
  }
  if (bucket === 'wrong_or_ambiguous_association') {
    const ambiguous = ordinal % 2 === 0;
    const otherPo = `PO-OTHER-${String(ordinal).padStart(3, '0')}`;
    return {
      body: localized(locale, {
        zh: ambiguous ? `请确认是 ${poNumber}-A 还是 ${poNumber}-B；邮件信息不足。demo.sender@example.test` : `此回复对应 ${otherPo}，不属于候选订单。demo.sender@example.test`,
        en: ambiguous ? `Please confirm whether this is ${poNumber}-A or ${poNumber}-B; the message is ambiguous. demo.sender@example.test` : `This reply refers to ${otherPo}, not a candidate order. demo.sender@example.test`,
        mixed: ambiguous ? `请确认 ${poNumber}-A or ${poNumber}-B，association ambiguous。demo.sender@example.test` : `Reply refers to ${otherPo}，不是候选订单。demo.sender@example.test`,
        qq: ambiguous ? `请问是 ${poNumber}-A 还是 ${poNumber}-B？信息不够。` : `这个回复是 ${otherPo} 的，不是候选订单。`,
      }),
      association: ambiguous ? 'ambiguous' : 'unmatched', candidates: ambiguous ? 2 : 1,
      validation: 'review_required', approvalRequired: true,
    };
  }
  const notShipped = locale === 'en-US' ? 'not shipped' : '尚未发货';
  const conflictingDate = `2026-10-${String(10 + (ordinal % 8)).padStart(2, '0')}`;
  return {
    body: localized(locale, {
      zh: `${poNumber} 一处写交期 ${exactDate}，另一处又写 ${conflictingDate}；目前${notShipped}，数量也未确认。demo.sender@example.test`,
      en: `${poNumber} says delivery ${exactDate}, but later says ${conflictingDate}; goods are ${notShipped} and quantity is unconfirmed. demo.sender@example.test`,
      mixed: `${poNumber} delivery ${exactDate}，but conflicts with ${conflictingDate}；status ${notShipped}，qty unknown。demo.sender@example.test`,
      qq: `${poNumber} 前面写 ${exactDate}，后面又写 ${conflictingDate}，目前${notShipped}，数量没确认。`,
    }),
    facts: { shipmentStatus: { value: 'not_shipped', evidence: notShipped } },
    validation: 'review_required', approvalRequired: true,
  };
}

function evidenceFrom(body: string, facts: Partial<Record<SupplierReplyField, Fact>>): { extracted: SupplierReplyExtracted; evidence: EvidenceSpan[] } {
  const extracted = emptyExtracted();
  const evidence: EvidenceSpan[] = [];
  for (const [field, fact] of Object.entries(facts) as Array<[SupplierReplyField, Fact]>) {
    const start = body.indexOf(fact.evidence);
    if (start < 0 || body.lastIndexOf(fact.evidence) !== start) throw new Error(`${field} evidence must occur exactly once`);
    extracted[field] = fact.value;
    evidence.push({ field, start, end: start + fact.evidence.length, text: fact.evidence });
  }
  evidence.sort((a, b) => a.start - b.start || a.field.localeCompare(b.field));
  return { extracted, evidence };
}

export function generateSupplierReplyDataset(): SupplierReplyCaseV1[] {
  const cases: SupplierReplyCaseV1[] = [];
  for (const [bucketIndex, bucket] of PRIMARY_SCENARIO_BUCKETS.entries()) {
    for (let ordinal = 1; ordinal <= 30; ordinal += 1) {
      const index = bucketIndex * 30 + ordinal - 1;
      const serial = String(index + 1).padStart(3, '0');
      const locale = locales[index % locales.length]!;
      const poNumber = `PO-DEMO-${serial}`;
      const rendered = scenario(bucket, ordinal, locale, poNumber);
      const candidateCount = rendered.candidates ?? 1;
      const candidates = Array.from({ length: candidateCount }, (_, candidateIndex) => {
        const suffix = candidateCount === 2 ? `-${candidateIndex === 0 ? 'A' : 'B'}` : '';
        return {
          supplierId: `supplier:synthetic:${serial}${suffix.toLowerCase()}`,
          poId: `purchase-order:synthetic:${serial}${suffix.toLowerCase()}`,
          supplierName: `Fictional Components ${serial}${suffix}`,
          poNumber: `${poNumber}${suffix}`,
        };
      });
      const association = rendered.association ?? 'matched';
      const { extracted, evidence } = evidenceFrom(rendered.body, rendered.facts ?? {});
      const adversarial = bucket === 'quoted_history_contamination' || bucket === 'wrong_or_ambiguous_association' || bucket === 'missing_or_contradictory_facts';
      cases.push({
        caseId: `sr-v1-${serial}`,
        datasetVersion: 'supplier-replies-v1',
        provenance: 'synthetic_contract_case',
        locale,
        scenarioTags: [bucket],
        difficulty: adversarial ? 'adversarial' : ordinal % 3 === 0 ? 'intermediate' : 'basic',
        adversarialFlags: adversarial ? [bucket === 'quoted_history_contamination' ? 'quoted_history' : bucket === 'wrong_or_ambiguous_association' ? 'association_conflict' : 'contradictory_or_missing_fact'] : [],
        receivedAt: '2026-09-14T08:00:00.000Z',
        body: rendered.body,
        candidates,
        expected: {
          association: { status: association, poId: association === 'matched' ? candidates[0]!.poId : null },
          extracted,
          unknownFields: (Object.entries(extracted) as Array<[SupplierReplyField, string | null]>).filter(([, value]) => value === null).map(([field]) => field),
          evidence,
          validation: rendered.validation ?? 'accepted',
          approvalRequired: rendered.approvalRequired ?? false,
        },
      });
    }
  }
  return cases;
}

export function serializeSupplierReplyDataset(cases: readonly SupplierReplyCaseV1[]): Uint8Array {
  return new TextEncoder().encode(`${cases.map((value) => JSON.stringify(value)).join('\n')}\n`);
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function supplierReplyDatasetDistribution(cases: readonly SupplierReplyCaseV1[]) {
  return {
    locale: countBy(cases.map((value) => value.locale)),
    difficulty: countBy(cases.map((value) => value.difficulty)),
    association: countBy(cases.map((value) => value.expected.association.status)),
    validation: countBy(cases.map((value) => value.expected.validation)),
    primaryScenario: countBy(cases.map((value) => value.scenarioTags[0]!)),
  };
}

async function main(): Promise<void> {
  if (!process.argv.includes('--write')) throw new Error('Pass --write to replace the checked-in dataset and digest');
  const cases = generateSupplierReplyDataset();
  const bytes = serializeSupplierReplyDataset(cases);
  const digest = sha256Hex(bytes);
  await writeFile(datasetPath, bytes);
  await writeFile(digestPath, `${digest}\n`, 'utf8');
  console.log(JSON.stringify({ cases: cases.length, digest, ...supplierReplyDatasetDistribution(cases) }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : 'generation failed'); process.exit(1); });
}
