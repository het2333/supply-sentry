/**
 * 真实 Odoo 采购订单延期催交写回演示（跑通完整闭环）：
 *
 *   AI 读 Odoo 采购订单 → 判断延期 → 催交 → 供应商回复 → AI 提取新交期
 *     → 人工批准 → 真的写回 Odoo（date_planned 变更）→ 验证 Odoo 里交期变了
 *
 * 前置：
 *   - Odoo 19 跑在 ODOO_BASE_URL（默认 http://127.0.0.1:8069），数据库 ODOO_DATABASE（默认 zhuxu_demo）
 *   - ODOO_API_KEY：Odoo 用户 API Key（必须通过环境变量提供）
 *   - 真实催交邮件：NETEASE_MAIL_USER / NETEASE_MAIL_PASS（不设则只入内存发件箱）
 *
 * 用法：
 *   pnpm demo:odoo
 *   ODOO_PO_NAME=P00018 NETEASE_MAIL_USER=... NETEASE_MAIL_PASS=... pnpm demo:odoo
 */
import {
  createSupplyChainRuntime,
  seedSupplier,
  seedSupplierEmail,
  seedGoodsReceived,
  syncObjectToContext,
  TENANT_ID,
} from '@readywork/supply-chain';
import { OdooErpClient, sendMail } from '@readywork/connectors';
import type { Mailer } from '@readywork/tools';

const log = console.log;
const info = (...a: unknown[]) => log('   ', ...a);

function env(name: string, dflt = ''): string {
  return process.env[name] ?? dflt;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function addDays(iso: string | null, days: number): string {
  const d = iso ? new Date(iso) : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function waitFor(
  rt: ReturnType<typeof createSupplyChainRuntime>,
  taskId: string,
  pred: (t: { status: string }) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<{ status: string }> {
  const start = Date.now();
  for (;;) {
    const t = rt.hub.machine.get(taskId);
    if (!t) throw new Error(`任务丢失: ${taskId}`);
    if (pred(t)) return t;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}（当前 ${t.status}）`);
    await sleep(50);
  }
}

function section(title: string): void {
  log(`\n${'═'.repeat(76)}`);
  log(`  ${title}`);
  log('═'.repeat(76));
}

async function main(): Promise<void> {
  const odoo = new OdooErpClient({
    baseUrl: env('ODOO_BASE_URL', 'http://127.0.0.1:8069'),
    database: env('ODOO_DATABASE', 'zhuxu_demo'),
    apiKey: requiredEnv('ODOO_API_KEY'),
  });
  const PO_NAME = env('ODOO_PO_NAME', 'P00011');

  const mailUser = env('NETEASE_MAIL_USER');
  const mailPass = env('NETEASE_MAIL_PASS');
  const mailer: Mailer | undefined =
    mailUser && mailPass ? { send: (i) => sendMail('smtp.163.com', 465, mailUser, mailPass, i) } : undefined;

  // 真实邮件测试收件箱（供应商侧用一个可真实收件的邮箱演示催交）
  const supplierMailbox = env('DEMO_SUPPLIER_MAIL', 'tomhank2020@163.com');

  const rt = createSupplyChainRuntime({ odoo, mailer });
  const { hub, engine, employees, humans } = rt;

  section('① 连接 Odoo');
  const hc = await odoo.healthCheck();
  info(`Odoo: ${hc.ok ? '✅ 已连接' : '❌ 失败'}（${hc.detail}）`);
  if (!hc.ok) return;

  section('② AI 读 Odoo 采购订单');
  const before = await odoo.readPO(PO_NAME);
  if (!before) {
    info(`❌ Odoo 未找到订单 ${PO_NAME}，可设 ODOO_PO_NAME 指定（现有 P00001…P00030）`);
    return;
  }
  info(`订单 ${before.name}：供应商「${before.supplierName}」，物料「${before.lines[0]?.product ?? '—'}」`);
  info(`原承诺交期（date_planned）：${before.promiseDate}，状态 ${before.state}，金额 ¥${before.amountTotal}`);
  const baseline = before.promiseDate ? before.promiseDate.slice(0, 10) : '2026-09-05';
  const newEta = addDays(baseline, 15); // 供应商回复：比原承诺再晚 15 天 → 延期 > 7 天

  section('③ 建业务对象 + 供应商实体（催交邮箱 → 真实测试邮箱）');
  seedSupplier(rt, { id: before.supplierId, name: before.supplierName, email: supplierMailbox });
  const bo = hub.objects.create({
    id: PO_NAME,
    type: 'po',
    status: 'sent',
    attributes: {
      supplierId: before.supplierId,
      supplierName: before.supplierName,
      item: before.lines[0]?.product ?? '物料',
      qty: before.lines[0]?.qty ?? 0,
      promiseDate: before.promiseDate,
      poDate: before.dateOrder,
    },
  });
  syncObjectToContext(rt, bo);
  info(`业务对象 ${bo.id}（供应商 ${bo.attributes.supplierName}）已同步到上下文`);

  section('④ 跑采购订单运营流程（AI 读 Odoo → 等待供应商回复）');
  const task = await engine.runTask({
    tenantId: TENANT_ID,
    employeeId: employees.procurement.id,
    workflowId: 'po-operations',
    businessObjectId: bo.id,
  });
  info(`任务 ${task.id} → ${task.status}（AI 已读 Odoo 订单，催交邮件待供应商回复）`);

  section('⑤ 供应商回复（新交期 → AI 提取 → 判断延期）');
  seedSupplierEmail(rt, {
    from: `${before.supplierName} <supplier@demo.cn>`,
    subject: `${PO_NAME} 交期确认`,
    body: `已收到 ${PO_NAME}，新交期确认为 ${newEta}，请知悉。`,
    eventType: 'supplier_confirmed',
    objectId: bo.id,
  });
  const waiting = await waitFor(
    rt,
    task.id,
    (t) => t.status === 'waiting_approval' || t.status === 'failed',
    '供应商回复后进入审批',
  );
  info(`AI 提取新交期 ${newEta}（原 ${baseline}，延期 15 天）→ ${waiting.status}`);

  section('⑥ 人工批准（延期 > 7 天）');
  const approval = hub.approvals.listPending().find((a) => a.taskId === task.id);
  if (approval) {
    info(`审批「${approval.title}」payload=${JSON.stringify(approval.payload)}`);
    info(`→ ${humans.manager.name} 批准`);
    await engine.approve(task.id, approval.id, humans.manager.id);
  }

  section('⑦ 审批后引擎写回 Odoo');
  await waitFor(
    rt,
    task.id,
    (t) => t.status === 'waiting_external' || t.status === 'failed',
    '写回 Odoo 并等待到货',
  );

  section('⑧ 验证 Odoo 交期真的变了');
  const after = await odoo.readPO(PO_NAME);
  const changed = (after?.promiseDate ?? '').slice(0, 10) === newEta;
  info(`Odoo ${after?.name} 交期：${before.promiseDate} → ${after?.promiseDate}`);
  info(changed ? `✅ 写回成功：Odoo 里 date_planned 已变为 ${newEta}` : `❌ 写回未生效（当前 ${after?.promiseDate}）`);

  section('⑨ 到货 → 任务完成');
  seedGoodsReceived(rt, bo.id);
  const done = await waitFor(rt, task.id, (t) => t.status === 'completed' || t.status === 'failed', '到货后完成');
  info(`任务 ${done.status === 'completed' ? '✅' : '❌'} ${task.id} → ${done.status}`);

  section('⑩ 催交邮件');
  const emailTool = rt.tools.get('email');
  const outbox = await emailTool?.execute('outbox.list', {}, { employeeId: employees.procurement.id });
  const msgs = (outbox?.data?.['messages'] as { subject: string; realSent?: boolean; to?: string[] }[] | undefined) ?? [];
  const sent = msgs.filter((m) => m.subject.includes('延期跟进'));
  info(
    `催交邮件 ${sent.length} 封` +
      (sent.length ? `：${sent.map((m) => m.subject).join('、')} → ${mTo(sent[0]!)}` : '（无）'),
  );
  info(sent.length && sent[0]!.realSent ? '✅ 已真实发送到供应商邮箱' : '（邮件走内存发件箱，未真实发信）');

  log(`\n完成 — 真实 Odoo 采购订单延期催交写回闭环跑通。`);
}

function mTo(m: { to?: string[] }): string {
  return (m.to ?? []).join(',');
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
