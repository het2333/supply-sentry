/**
 * ReadyWork · 平台全流程真实数据跑通验证
 * 覆盖：编排器 8 路径 / DeepSeek 意图识别 / 三个真实工作流端到端（Odoo 真实写入）/
 *       聊天助手（查询 + 确认门 + 真实邮件）/ 异常工作台批准 / 通知事件流 / Rules
 * 用法：DEEPSEEK_API_KEY=... ODOO_API_KEY=... ODOO_DATABASE=... node e2e.mjs
 */
const API = 'http://127.0.0.1:4173';
const ODOO = 'http://127.0.0.1:8069';
const ODOO_H = {
  'authorization': 'bearer ' + (process.env.ODOO_API_KEY || ''),
  'x-odoo-database': process.env.ODOO_DATABASE || 'zhuxu_demo',
  'content-type': 'application/json',
};
const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
const DS_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

let pass = 0, fail = 0;
const log = (ok, name, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`); };
const get = (p) => fetch(API + p).then((r) => r.json());
const post = (p, b) => fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function odooLine(pname) {
  try {
    const r = await fetch(`${ODOO}/json/2/purchase.order.line/search_read`, { method: 'POST', headers: ODOO_H, body: JSON.stringify({ domain: [['order_id.name', '=', pname]], fields: ['date_planned'] }) });
    const rows = await r.json();
    return rows[0]?.date_planned ?? 'N/A';
  } catch (e) { return 'ERR:' + e.message; }
}

async function deepseekIntent(emailText) {
  const res = await fetch(`${DS_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DS_KEY}` },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: '你是采购事件识别模块。把供应商邮件分类为以下意图之一：supplier_reject（拒单/无法接单/无产能）、invoice（发票/开票）、delay（延期/新交期）、rfq_quote（报价）、other。并从邮件提取采购单号(poNumber，形如 P00011)、新交期(newEta，形如 2026-10-15，没有则为空)、置信度(confidence 0~1)。只输出一个 JSON 对象：{"intent":"...","poNumber":"...","newEta":"...","confidence":0.9,"reasoning":"一句话"}，不要输出其它文字。' },
        { role: 'user', content: emailText },
      ],
      temperature: 0,
    }),
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}

// ────────────────────────────────────────────────
console.log('══════════ ReadyWork 平台全流程真实跑通 ══════════\n');

const ov = await get('/api/overview').catch(() => null);
log(!!ov && !!ov.employees, '服务健康', `员工 ${ov?.employees?.total ?? '?'} / 任务 ${ov?.tasks?.total ?? '?'} / 待审批 ${ov?.tasks?.pendingApprovals ?? '?'}`);

// ═════ A. 采购路径编排器：8 条规则路径 ═════
console.log('\n═══ A. 采购路径编排器（规则表 · 真实决策）═══');
const paths = [
  ['供应商拒单(有备选) → 返回询价', { kind: 'po', intent: 'supplier_reject', hasPo: true, hasQualifiedSupplier: true }, 'rfq'],
  ['供应商拒单(无备选) → 寻源', { kind: 'po', intent: 'supplier_reject', hasPo: true, hasQualifiedSupplier: false }, 'sourcing'],
  ['发票+PO+收货 → 三单匹配', { kind: 'invoice', hasPo: true, hasReceipt: true, hasInvoice: true }, 'invoice-match'],
  ['发票+PO 未收货 → 等待收货', { kind: 'invoice', hasPo: true, hasReceipt: false, hasInvoice: true }, 'wait-receipt'],
  ['无 PO 发票 → 异常', { kind: 'invoice', hasPo: false, hasInvoice: true }, 'exception'],
  ['已有 PO → 直接执行', { kind: 'po', hasPo: true, poName: 'P00011' }, 'po-execution'],
  ['合同价有效 → 跳过询价', { kind: 'event', hasPo: false, hasContractPrice: true, contractPriceValid: true }, 'po-execution'],
  ['无有效合同价 → 询价', { kind: 'event', hasPo: false, hasContractPrice: false }, 'rfq'],
];
for (const [name, input, expect] of paths) {
  const d = await post('/api/orchestrate', input);
  log(d.entry === expect, `编排 · ${name}`, `→ ${d.entry}（期望 ${expect}）| ${d.reason}`);
}

// ═════ B. DeepSeek 意图识别 → 规则路由（LLM 只做理解，路由由规则表拍板）═════
console.log('\n═══ B. DeepSeek 意图识别 → 编排路由 ═══');
const emails = [
  ['供应商拒单邮件', '主题：PO-P00019 无法接单\n正文：很抱歉，PO-P00019 因近期产能不足无法接单，请另寻其他供应商。', 'supplier_reject'],
  ['供应商发票邮件', '主题：INV-9001 开票通知\n正文：贵司采购单 P00011 的发票 INV-9001 已开出，含税金额 11730 元。', 'invoice'],
  ['供应商延期邮件', '主题：P00029 交期确认\n正文：关于 P00029，因原料到货延迟，新交期确认为 2026 年 10 月 15 日。', 'delay'],
  ['供应商报价邮件', '主题：RFQ-2001 报价\n正文：贵司询价的 M6 紧固件，报价：单价 0.15 元，交期 15 天。', 'rfq_quote'],
];
for (const [name, email, expectIntent] of emails) {
  try {
    const r = await deepseekIntent(email);
    const mapped = r.intent === 'supplier_reject' ? { kind: 'po', intent: r.intent, hasPo: true }
      : r.intent === 'invoice' ? { kind: 'invoice', intent: r.intent, hasInvoice: true, hasPo: Boolean(r.poNumber), hasReceipt: true }
      : r.intent === 'delay' ? { kind: 'po', intent: r.intent, hasPo: true }
      : { kind: 'requisition', intent: r.intent, hasPo: false };
    const d = await post('/api/orchestrate', mapped);
    log(r.intent === expectIntent, `意图识别 · ${name}`, `DeepSeek→${r.intent}(conf ${r.confidence}, ${r.poNumber || '无单号'}) 路由→${d.entry} | ${d.reason}`);
  } catch (e) { log(false, `意图识别 · ${name}`, String(e)); }
}

// ═════ C. 异常工作台当前数据（真实富化）═════
console.log('\n═══ C. 异常工作台（真实数据）═══');
const excs = await get('/api/exceptions');
log(excs.length === 3, '3 条 open 异常', excs.map((e) => `${e.objectId}(${e.type})`).join(', '));
const excOf = (oid) => excs.find((e) => e.objectId === oid);
const rfqExc = excOf('rfq:2001');
const poExc = excOf('P00011');
const invExc = excOf('inv:9001');
log(!!rfqExc?.quotes?.length && rfqExc.amount > 0, 'RFQ 报价表富化', JSON.stringify(rfqExc?.quotes?.map((q) => `${q.supplier} ${q.price}元 ${q.score}分${q.recommended ? ' ★推荐' : ''}`)));
log(!!invExc?.threeWay && invExc.threeWay.invoice?.name === 'BILL-4', '三单对照富化', `PO ${invExc?.threeWay?.po?.amount} / 发票 ${invExc?.threeWay?.invoice?.amount} / 差异 ${invExc?.threeWay?.variancePct}%`);
log(!!poExc && poExc.confidence === 0.88, '异常置信度', `rfq ${rfqExc?.confidence} / po ${poExc?.confidence} / inv ${invExc?.confidence}`);

// ═════ C1. RFQ 中标审批 → 批准 → 落单 ═════
console.log('\n═══ C1. 询价流程端到端：批准推荐供应商 → 落单 ═══');
const rfqApprove = await post(`/api/exceptions/${rfqExc.id}/approve`, {});
log(rfqApprove.ok, '批准 RFQ 定标（批准推荐供应商）', `taskStatus=${rfqApprove.taskStatus} by=${rfqApprove.by}`);
await sleep(300);
const rfqTask = (await get('/api/tasks')).find((t) => t.workflowId === 'rfq-process');
log(rfqTask?.status === 'completed', 'RFQ 工作流完成', `status=${rfqTask?.status}`);
const rfqExcAfter = (await get('/api/exceptions')).find((e) => e.objectId === 'rfq:2001');
log(!rfqExcAfter, 'RFQ 异常已随审批关闭');

// ═════ C2. PO 延期审批 → 批准 → Odoo 真实写入 → 到货 → 关闭 ═════
console.log('\n═══ C2. 采购订单执行端到端：接受新交期 → ERP 写入 → 到货关闭 ═══');
const newEta = String(poExc.context['newDate'] ?? '');
const before = await odooLine('P00011');
const poApprove = await post(`/api/exceptions/${poExc.id}/approve`, {});
log(poApprove.ok, '批准延期审批（接受新交期）', `taskStatus=${poApprove.taskStatus}`);
await sleep(400);
const after = await odooLine('P00011');
log(after.slice(0, 10) === newEta && before.slice(0, 10) !== after.slice(0, 10), `Odoo date_planned 真实改写 ${before.slice(0, 10)} → ${after.slice(0, 10)}（期望 ${newEta}）`);
let poTask = (await get('/api/tasks')).find((t) => t.workflowId === 'po-operations');
log(poTask?.status === 'waiting_external', 'PO 任务进入等待到货', `status=${poTask?.status}`);
const inject = await post('/api/events/inject', { eventType: 'goods_received', objectId: 'P00011' });
log(!!inject, '注入到货事件 goods_received', JSON.stringify(inject));
await sleep(800);
poTask = (await get('/api/tasks')).find((t) => t.workflowId === 'po-operations');
log(poTask?.status === 'completed', 'PO 工作流到货关闭完成', `status=${poTask?.status}`);
const poExcAfter = (await get('/api/exceptions')).find((e) => e.objectId === 'P00011');
log(!poExcAfter, 'PO 异常已关闭');

// ═════ C3. 发票三单差异 → 批准 → 应付台账 ═════
console.log('\n═══ C3. 发票与三单匹配端到端：批准差异 → 应付 ═══');
const invApprove = await post(`/api/exceptions/${invExc.id}/approve`, {});
log(invApprove.ok, '批准三单差异（批准差异）', `taskStatus=${invApprove.taskStatus}`);
await sleep(300);
const invTask = (await get('/api/tasks')).find((t) => t.workflowId === 'invoice-match');
log(invTask?.status === 'completed', '发票工作流完成（应付台账已登记）', `status=${invTask?.status}`);
const invExcAfter = (await get('/api/exceptions')).find((e) => e.objectId === 'inv:9001');
log(!invExcAfter, '发票异常已关闭');

// ═════ C4. 聊天助手：查询 + 确认门 + 真实邮件 ═════
console.log('\n═══ C4. 自然语言助手（DeepSeek + 确认门）═══');
try {
  const q = await post('/api/chat', { message: '我有哪些任务？', history: [] });
  log(/3 个任务/.test(q.reply ?? '') || /已完成/.test(q.reply ?? ''), '查询「我有哪些任务？」', (q.reply ?? '').replace(/\n/g, ' ').slice(0, 90));
} catch (e) { log(false, '查询「我有哪些任务？」', String(e)); }
try {
  const q = await post('/api/chat', { message: '显示 P00011 采购订单详情', history: [] });
  log(/P00011/.test(q.reply ?? '') && /交期/.test(q.reply ?? ''), '查询「显示 P00011 详情」（真实 Odoo）', (q.reply ?? '').replace(/\n/g, ' ').slice(0, 110));
} catch (e) { log(false, '查询 P00011', String(e)); }
try {
  const sendReq = '给 tomhank2020@163.com 发一封邮件，主题「ReadyWork 端到端测试」，正文「这是一封由 AI 采购执行员工在确认后发送的测试邮件。」';
  const s1 = await post('/api/chat', { message: sendReq, history: [] });
  const pending = (s1.actionPlan ?? []).some((p) => p.level === 'confirm');
  log(pending, '发邮件第一轮：待确认不执行', s1.reply?.slice(0, 80));
  if (pending) {
    const s2 = await post('/api/chat', { message: sendReq, history: [], confirm: true });
    const done = (s2.actions ?? []).includes('send_email') || /已成功发送|已发送|已发出/.test(s2.reply ?? '');
    log(done, '确认后执行：真实邮件已发送（NetEase SMTP）', (s2.reply ?? '').replace(/\n/g, ' ').slice(0, 100));
  } else {
    log(false, '确认后执行：真实邮件', JSON.stringify(s1.actionPlan));
  }
} catch (e) { log(false, '聊天发邮件', String(e)); }

// ═════ D. 通知 / 事件流 ═════
console.log('\n═══ D. 通知 · 事件流（铃铛数据源）═══');
const evs = await get('/api/events');
const has = (t) => evs.some((e) => e.type === t);
log(has('task.approved'), '事件流含 task.approved ×' + evs.filter((e) => e.type === 'task.approved').length);
log(has('task.completed'), '事件流含 task.completed ×' + evs.filter((e) => e.type === 'task.completed').length);
log(evs.some((e) => e.type === 'tool.called' && e.action === 'po.update'), '事件流含 erp.po.update（Odoo 写入轨迹）');
log(evs.some((e) => e.type === 'context.event' && e.eventType === 'goods_received'), '事件流含 goods_received');
log(evs.some((e) => e.type === 'context.event' && e.eventType === 'notify.sent'), '事件流含 notify.sent');

// ═════ E. Rules / 异常类型 ═════
console.log('\n═══ E. Rules（core 单一事实源）═══');
const rules = await get('/api/rules');
log(rules.thresholds?.length === 3, '审批阈值 3 组', rules.thresholds?.map((t) => `${t.name}≤${t.auto}自动/>${t.buyer}经理`).join(' | '));
log(rules.exceptionTypes?.length === 12, '异常类型 12 种', rules.exceptionTypes?.map((e) => e.id).join(', '));

// ═════ F. 最终状态 ═════
console.log('\n═══ F. 最终状态 ═══');
const finalExcs = await get('/api/exceptions');
const finalTasks = await get('/api/tasks');
log(finalExcs.length === 0, '异常工作台清空（全部 AI 闭环处理）', `open=${finalExcs.length}`);
log(finalTasks.every((t) => t.status === 'completed'), '全部任务完成', finalTasks.map((t) => `${t.workflowId}=${t.status}`).join(', '));

console.log(`\n══════════ 结果：${pass} 通过 / ${fail} 失败 ══════════`);
process.exit(fail > 0 ? 1 : 0);
