/**
 * 报价与订单员工（销售侧第二员工）演示：
 *   客户询价 → 产品选型 → 核价交期 → 低毛利审批 → 生成报价单 → 邮件发送
 *
 * 用法：pnpm demo:quote
 */
import { createSupplyChainRuntime, syncObjectToContext, TENANT_ID, HUMAN_SALES_MANAGER } from '@readywork/supply-chain';

const log = console.log;
const info = (...a: unknown[]) => log('   ', ...a);

function section(title: string): void {
  log(`\n${'═'.repeat(72)}`);
  log(`  ${title}`);
  log('═'.repeat(72));
}

async function main(): Promise<void> {
  const rt = createSupplyChainRuntime();
  const { hub, engine, employees } = rt;
  const salesManager = hub.org.getHuman(HUMAN_SALES_MANAGER);

  section('① 客户 + 询价邮件（销售侧上下文）');
  rt.context.upsertEntity({ id: 'cust:001', type: 'customer', attributes: { name: '上海XX化工', email: 'buyer@cust.cn' } });
  rt.context.upsertEntity({
    id: 'email:rfq-1001',
    type: 'email',
    attributes: {
      from: 'buyer@cust.cn',
      subject: '询价 控制阀 CV-420',
      body: '请报价：控制阀，介质：水，温度：80℃，压力：1.6MPa，口径：DN100，数量 20 台。',
    },
  });
  info(`客户 上海XX化工 发来询价：控制阀（水/80℃/1.6MPa/DN100）`);

  section('② 跑「客户报价流程」（报价与订单员工）');
  const bo = hub.objects.create({
    id: 'RFQ-1001',
    type: 'rfq',
    status: 'submitted',
    attributes: { customerEmail: 'buyer@cust.cn', customerName: '上海XX化工' },
  });
  syncObjectToContext(rt, bo);
  const task = await engine.runTask({
    tenantId: TENANT_ID,
    employeeId: employees.quote.id,
    workflowId: 'quote-process',
    businessObjectId: bo.id,
  });
  info(`任务 ${task.id} → ${task.status}（选型 CV-420-316L，核价成本 ¥632 → 报价 ¥780，毛利率 19% < 25%）`);

  section('③ 低毛利审批（销售经理）');
  const approval = hub.approvals.listPending().find((a) => a.taskId === task.id);
  if (approval) {
    info(`审批「${approval.title}」payload=${JSON.stringify(approval.payload)}`);
    info(`→ ${salesManager?.name ?? '销售经理'} 批准`);
    await engine.approve(task.id, approval.id, HUMAN_SALES_MANAGER);
  }

  section('④ 生成报价单 + 发送邮件');
  await new Promise((r) => setTimeout(r, 100));
  const done = hub.machine.get(task.id);
  const quote = done?.checkpoint.workspace['quote'] as { quoteId?: string } | undefined;
  const matched = done?.checkpoint.workspace['matched'] as { matched?: string; confidence?: number } | undefined;
  const price = done?.checkpoint.workspace['price'];
  info(`报价单 ${quote?.quoteId ?? '—'}（型号 ${matched?.matched ?? '—'}，单价 ¥${price}，置信度 ${matched?.confidence ?? '—'}）`);
  info(`任务最终状态 → ${done?.status}`);

  const emailTool = rt.tools.get('email');
  const outbox = await emailTool?.execute('outbox.list', {}, { employeeId: employees.quote.id });
  const msgs = (outbox?.data?.['messages'] as { subject: string; to?: string[] }[] | undefined) ?? [];
  const sent = msgs.filter((m) => m.subject.includes('报价单'));
  info(`报价邮件 ${sent.length} 封 → ${sent.map((m) => m.to?.join(',')).join('；') || '（无）'}`);

  log(`\n完成 — 报价与订单员工（销售侧）闭环跑通。`);
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
