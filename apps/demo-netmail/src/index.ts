/**
 * 真实网易邮箱闭环：催交 → 供应商回信（真发到 163）→ IMAP 真收 → 按单号路由
 *   → 提取新交期 → 延期审批 → 真回写 Odoo。
 *
 * 用法：
 *   NETEASE_MAIL_USER=tomhank2020@163.com NETEASE_MAIL_PASS=<授权码> \
 *   ODOO_BASE_URL=... ODOO_API_KEY=... pnpm demo:netmail
 */
import { createSupplyChainRuntime, seedSupplier, syncObjectToContext, TENANT_ID } from '@readywork/supply-chain';
import { OdooErpClient, ImapClient, sendMail, extractPoNumber } from '@readywork/connectors';
import type { InboundEmail } from '@readywork/connectors';

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

async function main(): Promise<void> {
  const PO_NAME = env('ODOO_PO_NAME', 'P00011');
  const mailUser = requiredEnv('NETEASE_MAIL_USER');
  const mailPass = requiredEnv('NETEASE_MAIL_PASS');
  const odoo = new OdooErpClient({
    baseUrl: env('ODOO_BASE_URL', 'http://127.0.0.1:8069'),
    database: env('ODOO_DATABASE', 'zhuxu_demo'),
    apiKey: requiredEnv('ODOO_API_KEY'),
  });

  section('① 读 Odoo 采购单');
  const po = await odoo.readPO(PO_NAME);
  if (!po) { info(`Odoo 未找到 ${PO_NAME}`); return; }
  const baseline = po.promiseDate ? po.promiseDate.slice(0, 10) : '2026-09-05';
  const newEta = addDays(baseline, 15);
  info(`Odoo ${po.name}（${po.supplierName}）原交期 ${baseline}，供应商将回复新交期 ${newEta}`);

  section('② 跑采购订单运营流程（等待供应商回信）');
  const rt = createSupplyChainRuntime({ odoo });
  const { hub, engine, employees, humans } = rt;
  seedSupplier(rt, { id: po.supplierId, name: po.supplierName, email: mailUser });
  const bo = hub.objects.create({
    id: po.name,
    type: 'po',
    status: 'sent',
    attributes: { supplierId: po.supplierId, supplierName: po.supplierName, item: po.lines[0]?.product, qty: po.lines[0]?.qty, promiseDate: po.promiseDate, poDate: po.dateOrder },
  });
  syncObjectToContext(rt, bo);
  const task = await engine.runTask({ tenantId: TENANT_ID, employeeId: employees.procurement.id, workflowId: 'po-operations', businessObjectId: bo.id });
  info(`任务 ${task.id} → ${task.status}`);

  section('③ 供应商回信：真发邮件到 163 邮箱');
  const subject = `${PO_NAME} 交期确认`;
  const body = `已收到 ${PO_NAME}，新交期确认为 ${newEta}，请知悉。`;
  const sent = await sendMail('smtp.163.com', 465, mailUser, mailPass, { to: mailUser, subject, body });
  info(`真发信 → ${sent.ok ? '✅ 已发出' : '❌ ' + sent.message}（主题「${subject}」）`);

  section('④ IMAP 真收 → 按单号路由 → 恢复任务');
  const imap = await ImapClient.connect({ host: 'imap.163.com', port: 993, user: mailUser, pass: mailPass });
  let routed = false;
  for (let attempt = 0; attempt < 10 && !routed; attempt++) {
    if (attempt > 0) await sleep(3000);
    for (const uid of await imap.fetchUnseenUids()) {
      const email = await imap.fetchEmail(uid);
      const poNumber = extractPoNumber(email.subject, email.body);
      // 只处理"本次发出的供应商回信"（正文含「新交期确认为」），避免误配历史催交邮件
      if (poNumber !== PO_NAME || !email.body.includes('新交期确认为')) continue;
      rt.context.upsertEntity({ id: `email:${email.id}`, type: 'email', attributes: { from: email.from, subject: email.subject, body: email.body } });
      rt.context.recordEvidence({ entityId: PO_NAME, source: `imap:${email.from}`, summary: email.subject });
      rt.hub.bus.emit({ type: 'context.event', eventType: 'supplier_confirmed', objectId: PO_NAME, payload: { from: email.from }, at: new Date().toISOString() });
      await imap.markSeen(uid);
      info(`✅ 收到回信「${email.subject}」→ 路由到 ${PO_NAME} → supplier_confirmed`);
      routed = true;
      break;
    }
  }
  await imap.logout();
  if (!routed) { info('❌ 10 次轮询内未收到回信'); return; }
  await sleep(400);
  info(`任务 → ${hub.machine.get(task.id)?.status}（提取新交期 ${newEta} → 延期 15 天 > 7 → 审批）`);

  section('⑤ 人工批准 + 真回写 Odoo');
  const approval = hub.approvals.listPending().find((a) => a.taskId === task.id);
  if (approval) {
    info(`审批「${approval.title}」payload=${JSON.stringify(approval.payload)} → ${humans.manager.name} 批准`);
    await engine.approve(task.id, approval.id, humans.manager.id);
    await sleep(400);
  }
  const after = await odoo.readPO(PO_NAME);
  const changed = (after?.promiseDate ?? '').slice(0, 10) === newEta;
  info(`Odoo ${after?.name} 交期：${baseline} → ${after?.promiseDate?.slice(0, 10)}`);
  info(changed ? '✅ 真实网易邮箱闭环跑通：真发 → IMAP 真收 → 解析 → 审批 → Odoo 交期真的变了' : '❌ 交期未变');
}

main().catch((e) => { console.error('失败:', e); process.exit(1); });
