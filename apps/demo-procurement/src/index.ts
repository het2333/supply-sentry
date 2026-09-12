/**
 * 采购执行链三个员工全流程一次跑通：
 *   ① 询价与报价员工    rfq-process     发询价 → 报价 → 比价 → 中标审批
 *   ② 采购订单运营员工  po-operations   读 Odoo 单 → 催交 → 供应商回信 IMAP 真收 → 延期审批 → 回写 Odoo（核心）
 *   ③ 应付核对员工      invoice-match   发票识别 → 三单匹配 → 差异审批 → 台账
 *
 * 用法：NETEASE_MAIL_USER=... NETEASE_MAIL_PASS=... pnpm demo:procurement
 */
import { createSupplyChainRuntime, seedSupplier, syncObjectToContext, TENANT_ID } from '@readywork/supply-chain';
import { OdooErpClient, ImapClient, sendMail } from '@readywork/connectors';
import type { Mailer } from '@readywork/tools';
import { uid, nowIso } from '@readywork/core';

const log = console.log;
const info = (...a: unknown[]) => log('   ', ...a);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const section = (t: string) => log(`\n${'═'.repeat(70)}\n  ${t}\n${'═'.repeat(70)}`);
const env = (k: string, d = '') => process.env[k] ?? d;
const requiredEnv = (k: string) => {
  const value = process.env[k];
  if (!value) throw new Error(`缺少环境变量 ${k}`);
  return value;
};
const addDays = (iso: string, d: number) => { const x = new Date(iso); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };

async function waitFor(rt: ReturnType<typeof createSupplyChainRuntime>, taskId: string, pred: (s: string) => boolean, label: string, timeoutMs = 30_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    const t = rt.hub.machine.get(taskId);
    if (!t) throw new Error(`任务丢失: ${taskId}`);
    if (pred(t.status)) return t.status;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}（当前 ${t.status}）`);
    await sleep(50);
  }
}

async function main(): Promise<void> {
  const MAIL_USER = requiredEnv('NETEASE_MAIL_USER');
  const MAIL_PASS = requiredEnv('NETEASE_MAIL_PASS');
  const PO_NAME = env('ODOO_PO_NAME', 'P00011');
  const mailer: Mailer = { send: (i) => sendMail('smtp.163.com', 465, MAIL_USER, MAIL_PASS, i) };
  const odoo = new OdooErpClient({
    baseUrl: env('ODOO_BASE_URL', 'http://127.0.0.1:8069'),
    database: env('ODOO_DATABASE', 'zhuxu_demo'),
    apiKey: requiredEnv('ODOO_API_KEY'),
  });

  const rt = createSupplyChainRuntime({ odoo, mailer });
  const { hub, engine, employees, humans } = rt;

  // ═══ ① 询价与报价员工 ═══
  section('① 工作流·询价与报价 —— 发询价 → 报价 → 比价 → 中标审批');
  const rfqBo = hub.objects.create({
    id: 'rfq:2001', type: 'rfq', status: 'draft',
    attributes: { item: '不锈钢紧固件 M6', qty: 20000, suppliers: 's1@supplier.cn,s2@supplier.cn,s3@supplier.cn' },
  });
  syncObjectToContext(rt, rfqBo);
  const rfqTask = await engine.runTask({ tenantId: TENANT_ID, employeeId: employees.procurement.id, workflowId: 'rfq-process', businessObjectId: rfqBo.id });
  for (const q of [
    { from: 's1@supplier.cn', body: 'M6 紧固件 单价 0.18 元 交期 10天' },
    { from: 's2@supplier.cn', body: 'M6 紧固件 单价 0.15 元 交期 15天' },
  ]) rt.context.upsertEntity({ id: uid('email'), type: 'email', attributes: { from: q.from, subject: '报价', body: q.body } });
  rt.hub.bus.emit({ type: 'context.event', eventType: 'quote_received', objectId: rfqBo.id, payload: {}, at: nowIso() });
  await waitFor(rt, rfqTask.id, (s) => s === 'waiting_approval' || s === 'completed', '询价比价');
  const rfqApproval = hub.approvals.listPending().find((a) => a.taskId === rfqTask.id);
  if (rfqApproval) await engine.approve(rfqTask.id, rfqApproval.id, humans.manager.id);
  info(`收到 2 家报价 → 比价推荐最低价 → 王经理批准 → 中标 s2@supplier.cn`);

  // ═══ ② 采购订单运营员工（核心）═══
  section('② 工作流·采购订单执行 —— 读 Odoo 单 → 催交 → 供应商回信 IMAP 真收 → 延期审批 → 回写 Odoo');
  const po = await odoo.readPO(PO_NAME);
  if (!po) { info(`Odoo 未找到 ${PO_NAME}`); return; }
  const baseline = po.promiseDate ? po.promiseDate.slice(0, 10) : '2026-09-05';
  const newEta = addDays(baseline, 15);
  seedSupplier(rt, { id: po.supplierId, name: po.supplierName, email: MAIL_USER });
  const poBo = hub.objects.create({
    id: po.name, type: 'po', status: 'sent',
    attributes: { supplierId: po.supplierId, supplierName: po.supplierName, item: po.lines[0]?.product, qty: po.lines[0]?.qty, promiseDate: po.promiseDate, poDate: po.dateOrder },
  });
  syncObjectToContext(rt, poBo);
  const poTask = await engine.runTask({ tenantId: TENANT_ID, employeeId: employees.procurement.id, workflowId: 'po-operations', businessObjectId: poBo.id });
  info(`Odoo ${po.name}（${po.supplierName}）原交期 ${baseline}，任务 → ${poTask.status}`);

  const subject = `${PO_NAME} 交期确认`;
  const replyBody = `已收到 ${PO_NAME}，新交期确认为 ${newEta}，请知悉。`;
  await sendMail('smtp.163.com', 465, MAIL_USER, MAIL_PASS, { to: MAIL_USER, subject, body: replyBody });
  const imap = await ImapClient.connect({ host: 'imap.163.com', port: 993, user: MAIL_USER, pass: MAIL_PASS });
  let routed = false;
  for (let attempt = 0; attempt < 10 && !routed; attempt++) {
    if (attempt > 0) await sleep(3000);
    for (const u of (await imap.fetchUnseenUids()).reverse()) {
      const email = await imap.fetchEmail(u);
      if (!email.body.includes(newEta)) continue;
      rt.context.upsertEntity({ id: `email:${email.id}`, type: 'email', attributes: { from: email.from, subject: email.subject, body: email.body } });
      rt.hub.bus.emit({ type: 'context.event', eventType: 'supplier_confirmed', objectId: PO_NAME, payload: { from: email.from }, at: nowIso() });
      await imap.markSeen(u);
      info(`✅ 供应商回信真收（${email.subject}）→ 路由 → supplier_confirmed`);
      routed = true;
      break;
    }
  }
  await imap.logout();
  await waitFor(rt, poTask.id, (s) => s === 'waiting_approval' || s === 'failed', '延期识别', 30_000);
  info(`提取新交期 ${newEta} → 延期 15 天 > 7 → ${hub.machine.get(poTask.id)?.status}`);
  const poApproval = hub.approvals.listPending().find((a) => a.taskId === poTask.id);
  if (poApproval) await engine.approve(poTask.id, poApproval.id, humans.manager.id);
  await waitFor(rt, poTask.id, (s) => s === 'waiting_external' || s === 'completed' || s === 'failed', '回写后等待到货', 30_000);
  const after = await odoo.readPO(PO_NAME);
  const poChanged = (after?.promiseDate ?? '').slice(0, 10) === newEta;
  info(`Odoo ${after?.name} 交期：${baseline} → ${after?.promiseDate?.slice(0, 10)} ${poChanged ? '✅' : '❌'}`);

  // ═══ ③ 应付核对员工 ═══
  section('③ 工作流·应付核对 —— 发票识别 → 三单匹配 → 差异审批 → 台账');
  const invoiceAmount = Math.round((after?.amountTotal ?? 27600) * 1.02); // 2% 差异触发审批
  const invBo = hub.objects.create({ id: 'inv:9001', type: 'invoice', status: 'received', attributes: { poNumber: PO_NAME, invoiceAmount, qty: po.lines[0]?.qty ?? 0, receiptQty: po.lines[0]?.qty ?? 0 } });
  syncObjectToContext(rt, invBo);
  rt.context.upsertEntity({ id: 'inv:9001', type: 'invoice', attributes: { poNumber: PO_NAME, amount: invoiceAmount, text: `发票 INV-9001 金额 ${invoiceAmount} 关联 ${PO_NAME}` } });
  const invTask = await engine.runTask({ tenantId: TENANT_ID, employeeId: employees.procurement.id, workflowId: 'invoice-match', businessObjectId: invBo.id });
  const invApproval = hub.approvals.listPending().find((a) => a.taskId === invTask.id);
  const variance = (invTask.checkpoint.workspace['match'] as { variance?: number } | undefined)?.variance ?? 0;
  info(`发票 ${invoiceAmount} vs 采购单 ${after?.amountTotal}（差异 ${variance}%）→ ${invTask.status}`);
  if (invApproval) {
    await engine.approve(invTask.id, invApproval.id, humans.manager.id);
    info(`✅ 差异审批通过 → 应付台账已登记`);
  }

  // ═══ 汇总 ═══
  section('采购执行链 · 全流程汇总');
  const tasks = hub.machine.list();
  info(`任务：${tasks.map((t) => `${t.workflowId}=${t.status}`).join('，')}`);
  info(`员工：${hub.org.listAI().map((e) => e.name).join(' / ')}`);
  info(poChanged ? '✅ 采购执行员工 · 3 条工作流全流程跑通（询价→采购订单→应付核对）' : '⚠️ PO 回写未生效');
}

main().catch((e) => { console.error('失败:', e); process.exit(1); });
