/**
 * 采购事件识别（DeepSeek）→ 规则路由 最小闭环演示。
 *
 * 分层：DeepSeek 只做「理解」（把自然语言邮件翻译成结构化意图），
 *       路由决策交给 Business Runtime 的 ProcurementOrchestrator（规则表/状态机）。
 *
 * 用法：DEEPSEEK_API_KEY=... pnpm demo:intake
 */
import { ProcurementOrchestrator, intentToPathInput } from '@readywork/supply-chain';
import type { PurchaseIntent } from '@readywork/supply-chain';

const env = (k: string, d = '') => process.env[k] ?? d;
const o = new ProcurementOrchestrator();

interface IntentResult {
  intent: PurchaseIntent;
  poNumber: string;
  newEta: string;
  confidence: number;
  reasoning: string;
}

/** 用 DeepSeek 把邮件翻译成结构化意图（只读，不触发任何动作） */
async function deepseekIntent(emailText: string): Promise<IntentResult> {
  const res = await fetch(`${env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env('DEEPSEEK_API_KEY', '')}` },
    body: JSON.stringify({
      model: env('DEEPSEEK_MODEL', 'deepseek-v4-flash'),
      messages: [
        {
          role: 'system',
          content:
            '你是采购事件识别模块。把供应商邮件分类为以下意图之一：supplier_reject（拒单/无法接单/无产能）、invoice（发票/开票）、delay（延期/新交期）、rfq_quote（报价）、other。' +
            '并从邮件提取采购单号(poNumber，形如 P00011)、新交期(newEta，形如 2026-10-15，没有则为空)、置信度(confidence 0~1)。' +
            '只输出一个 JSON 对象：{"intent":"...","poNumber":"...","newEta":"...","confidence":0.9,"reasoning":"一句话"}，不要输出其它文字。',
        },
        { role: 'user', content: emailText },
      ],
      temperature: 0,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const text = data.choices[0]!.message.content;
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text) as IntentResult;
}

const samples: { name: string; email: string }[] = [
  { name: '供应商拒单', email: '主题：PO-P00019 无法接单\n正文：很抱歉，PO-P00019 因近期产能不足无法接单，请另寻其他供应商。' },
  { name: '供应商发票', email: '主题：INV-9001 开票通知\n正文：贵司采购单 P00011 的发票 INV-9001 已开出，含税金额 11730 元，请安排核对。' },
  { name: '供应商延期', email: '主题：P00029 交期确认\n正文：关于 P00029，因原料到货延迟，新交期确认为 2026 年 10 月 15 日，请知悉。' },
  { name: '供应商报价', email: '主题：RFQ-2001 报价\n正文：贵司询价的 M6 紧固件，报价：单价 0.15 元，交期 15 天。' },
];

async function main(): Promise<void> {
  if (!env('DEEPSEEK_API_KEY', '')) {
    console.log('未配置 DEEPSEEK_API_KEY，跳过（可用 DEEPSEEK_API_KEY=... pnpm demo:intake）');
    return;
  }
  console.log('═'.repeat(72));
  console.log('  采购执行员工 · DeepSeek 意图识别 → 规则路由（最小闭环）');
  console.log('═'.repeat(72));
  for (const s of samples) {
    try {
      const r = await deepseekIntent(s.email);
      const decision = o.decide(intentToPathInput(r.intent, { poName: r.poNumber }));
      console.log(`\n  ${s.name}`);
      console.log(`    DeepSeek 识别 : ${r.intent}（${r.poNumber || '无单号'}）置信 ${r.confidence} — ${r.reasoning}`);
      console.log(`    规则路由     : ${decision.entry} → [${decision.workflows.join(', ') || '无'}]`);
      console.log(`    理由         : ${decision.reason}`);
    } catch (e) {
      console.log(`\n  ${s.name} 识别失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log('\n' + '═'.repeat(72));
  console.log('  LLM 只做「理解」，路由由 Business Runtime 规则表拍板（可审计、确定性）。');
}

void main();
