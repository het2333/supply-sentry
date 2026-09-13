/**
 * 报价与订单员工（销售侧）全流程 —— 真实客户邮箱：
 *   合成客户 supplier.demo@example.com 发来询价 → IMAP 真收 → 路由到报价员工
 *   → 选型 → 核价 → 低毛利审批 → 生成报价单 → 真发报价邮件给客户。
 *
 * 用法：pnpm demo:sales
 */
import { createSupplyChainRuntime, syncObjectToContext, TENANT_ID, HUMAN_SALES_MANAGER } from '@readywork/supply-chain';
import { sendMail, ImapClient } from '@readywork/connectors';
import type { Mailer } from '@readywork/tools';

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

const CUSTOMER_EMAIL = env('CUSTOMER_EMAIL', 'supplier.demo@example.com');
const MAIL_USER = requiredEnv('NETEASE_MAIL_USER');
const MAIL_PASS = requiredEnv('NETEASE_MAIL_PASS');

const mailer: Mailer = { send: (i) => sendMail('smtp.163.com', 465, MAIL_USER, MAIL_PASS, i) };

async function main(): Promise<void> {
  const rfqSubject = '询价 控制阀 CV-420';
  const rfqBody = '请报价：控制阀，介质：水，温度：80℃，压力：1.6MPa，口径：DN100，数量 20 台。';

  section('① 客户发来询价（真发到业务邮箱）');
  const sent = await sendMail('smtp.163.com', 465, MAIL_USER, MAIL_PASS, { to: MAIL_USER, subject: rfqSubject, body: rfqBody });
  info(`客户 ${CUSTOMER_EMAIL} 询价「${rfqSubject}」→ ${sent.ok ? '✅ 已发出' : '❌ ' + sent.message}`);

  section('② IMAP 真收客户询价 → 路由');
  const imap = await ImapClient.connect({ host: 'imap.163.com', port: 993, user: MAIL_USER, pass: MAIL_PASS });
  let receivedBody = '';
  for (let attempt = 0; attempt < 10 && !receivedBody; attempt++) {
    if (attempt > 0) await sleep(3000);
    for (const uid of await imap.fetchUnseenUids()) {
      const email = await imap.fetchEmail(uid);
      if (email.subject !== rfqSubject) continue;
      receivedBody = email.body;
      info(`✅ 收到客户询价「${email.subject}」→ 正文已提取`);
      break;
    }
  }
  await imap.logout();
  if (!receivedBody) { info('❌ 10 次轮询内未收到客户询价'); return; }

  section('③ 报价与订单员工跑报价流程');
  const rt = createSupplyChainRuntime({ mailer });
  const { hub, engine, employees } = rt;
  const salesManager = hub.org.getHuman(HUMAN_SALES_MANAGER);
  rt.context.upsertEntity({ id: 'cust:001', type: 'customer', attributes: { name: '客户', email: CUSTOMER_EMAIL } });
  rt.context.upsertEntity({ id: 'email:rfq', type: 'email', attributes: { from: CUSTOMER_EMAIL, subject: rfqSubject, body: receivedBody } });
  const bo = hub.objects.create({ id: 'RFQ-1001', type: 'rfq', status: 'submitted', attributes: { customerEmail: CUSTOMER_EMAIL, customerName: '客户' } });
  syncObjectToContext(rt, bo);
  const task = await engine.runTask({ tenantId: TENANT_ID, employeeId: employees.quote.id, workflowId: 'quote-process', businessObjectId: bo.id });
  info(`任务 ${task.id} → ${task.status}（选型 CV-420-316L → 核价 → 低毛利审批）`);

  section('④ 低毛利审批（销售经理）');
  const approval = hub.approvals.listPending().find((a) => a.taskId === task.id);
  if (approval) {
    info(`审批「${approval.title}」payload=${JSON.stringify(approval.payload)} → ${salesManager?.name ?? '销售经理'} 批准`);
    await engine.approve(task.id, approval.id, HUMAN_SALES_MANAGER);
    await sleep(400);
  }

  section('⑤ 报价单真发到客户邮箱');
  const done = hub.machine.get(task.id);
  const quote = done?.checkpoint.workspace['quote'] as { quoteId?: string } | undefined;
  const matched = done?.checkpoint.workspace['matched'] as { matched?: string } | undefined;
  const price = done?.checkpoint.workspace['price'];
  info(`任务 → ${done?.status}，报价单 ${quote?.quoteId ?? '—'}（型号 ${matched?.matched ?? '—'}，单价 ¥${price}）`);
  const emailTool = rt.tools.get('email');
  const outbox = await emailTool?.execute('outbox.list', {}, { employeeId: employees.quote.id });
  const msgs = (outbox?.data?.['messages'] as { subject: string; to?: string[]; realSent?: boolean }[] | undefined) ?? [];
  const quoteMail = msgs.find((m) => m.subject.includes('报价单'));
  info(`报价邮件 → ${quoteMail ? quoteMail.to?.join(',') : '无'}` + (quoteMail?.realSent ? `（✅ 已真发到客户 ${CUSTOMER_EMAIL}）` : '（未真发）'));

  log('\n完成 — 报价与订单员工销售侧全流程（真客户邮箱）跑通。');
}

main().catch((e) => { console.error('失败:', e); process.exit(1); });
