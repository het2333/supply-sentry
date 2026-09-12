import assert from 'node:assert/strict';
import type { DomainEvent, Task } from '@readywork/core';
import { nowIso, uid } from '@readywork/core';
import {
  TENANT_ID,
  erpOf,
  seedGoodsReceived,
  seedSupplier,
  seedSupplierEmail,
  syncObjectToContext,
} from '@readywork/supply-chain';
import type { SupplyChainRuntime } from '@readywork/supply-chain';

/**
 * V1 验证链（demo 与 demo:dsh 共用，业务层零改动）：
 * 创建员工 → 给权限 → 给业务任务 → AI执行 → 等待 → 恢复 → 调工具 → 人工审批 → 完成 → 评测
 * 覆盖一名「采购运营员工」的六个能力模块：需求处理 / 询价采购 / 采购订单 / 供应商跟进 / 异常处理 / 系统同步。
 * Agent 实现由外部注入（InMemory 桩 或 DeepSeekHarnessAdapter）。
 */

export interface ChainResult {
  overview: ReturnType<SupplyChainRuntime['tower']['overview']>;
  eventLog: DomainEvent[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForStatus(
  rt: SupplyChainRuntime,
  taskId: string,
  pred: (t: Task) => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<Task> {
  const start = Date.now();
  for (;;) {
    const t = rt.hub.machine.get(taskId);
    if (!t) throw new Error(`任务丢失: ${taskId}`);
    if (pred(t)) return t;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${label}（当前状态 ${t.status}）`);
    await sleep(25);
  }
}

function section(log: (l: string) => void, title: string): void {
  log(`\n${'═'.repeat(76)}`);
  log(`  ${title}`);
  log('═'.repeat(76));
}

export async function runValidationChain(
  rt: SupplyChainRuntime,
  opts: { log?: (l: string) => void; waitTimeoutMs?: number } = {},
): Promise<ChainResult> {
  const log = opts.log ?? console.log;
  const info = (...args: unknown[]) => log('   ', ...args);
  const { hub, engine, tower, employees, humans } = rt;
  const WAIT_MS = opts.waitTimeoutMs ?? 8_000;

  // ---------------------------------------------------------------- ① 创建员工
  section(log, '① Build Plane — 创建员工（Employee Definition）');
  for (const e of Object.values(employees)) {
    const spec = hub.specs.get(e.specId);
    if (!spec) throw new Error(`Spec 缺失: ${e.specId}`);
    const perm = spec.permissions.map((p) => `${p.effect === 'allow' ? '✓' : '✗'} ${p.resource}.${p.action}`).join('  ');
    info(`AI 员工「${e.name}」 [${e.id}]  岗位: ${spec.role}`);
    info(`   目标: ${spec.goals.map((g) => g.title).join(' / ')}    预算: ${spec.budget?.monthlyCap} ${spec.budget?.currency}`);
    info(`   权限: ${perm}`);
    info(`   审批规则: ${spec.approvalRules.map((r) => r.name).join(' / ') || '无'}`);
  }

  // ---------------------------------------------------------------- ② 给权限
  section(log, '② Governance — 权限与 Policy');
  const poSpec = hub.specs.get(employees.procurement.specId);
  if (!poSpec) throw new Error('procurement spec 缺失');
  assert.equal(hub.policy.can(poSpec.permissions, 'po.get', 'erp'), true, '应允许查询 PO');
  assert.equal(hub.policy.can(poSpec.permissions, 'po.update', 'erp'), true, '应允许修改承诺交期');
  assert.equal(hub.policy.can(poSpec.permissions, 'po.updatePrice', 'erp'), false, '应禁止修改采购价格');
  const triggered = hub.policy.evaluatePolicies(poSpec.policies, {
    employeeId: employees.procurement.id,
    action: 'po.updatePrice',
    resource: 'erp',
    now: new Date(),
  });
  assert.equal(triggered.length, 1, '价格锁定策略应触发');
  info(`✓ 允许 po.get / po.update（可修改承诺交期）`);
  info(`✗ 拒绝 po.updatePrice（不可修改采购价格）— Policy 命中「${triggered.map((p) => p.name).join('、')}」`);

  // ---------------------------------------------------------------- ③ 询价与报价员工（上游）
  section(log, '③ 询价与报价员工 — 发询价 → 等待报价 → 恢复 → 比价 → 审批 → 中标');
  const erp = erpOf(rt);
  const rfqBo = hub.objects.create({
    id: 'rfq:2001',
    type: 'rfq',
    status: 'draft',
    attributes: {
      item: '不锈钢紧固件 M6',
      qty: 20000,
      suppliers: 's1@supplier.cn,s2@supplier.cn,s3@supplier.cn',
    },
  });
  syncObjectToContext(rt, rfqBo);
  const rfqTask = await engine.runTask({
    tenantId: TENANT_ID,
    employeeId: employees.procurement.id,
    workflowId: 'rfq-process',
    businessObjectId: rfqBo.id,
  });
  assert.equal(rfqTask.status, 'waiting_external', '询价后应等待报价');
  info(`任务 ${rfqTask.id} → ${rfqTask.status}（询价邮件已发出，等待供应商报价）`);
  const quoteEmails: { from: string; subject: string; body: string }[] = [
    { from: 's1@supplier.cn', subject: '报价 M6', body: 'M6 紧固件 单价 0.18 元 交期 10天' },
    { from: 's2@supplier.cn', subject: '报价 M6', body: 'M6 紧固件 单价 0.15 元 交期 15天' },
  ];
  for (const q of quoteEmails) {
    rt.context.upsertEntity({ id: uid('email'), type: 'email', attributes: q });
    rt.context.recordEvidence({ entityId: rfqBo.id, source: `email:${q.from}`, summary: q.subject });
  }
  rt.hub.bus.emit({ type: 'context.event', eventType: 'quote_received', objectId: rfqBo.id, payload: {}, at: nowIso() });
  const rfqResumed = await waitForStatus(
    rt,
    rfqTask.id,
    (t) => t.status === 'waiting_approval' || t.status === 'completed',
    '等待报价事件恢复',
    WAIT_MS,
  );
  assert.equal(rfqResumed.status, 'waiting_approval', '比价后应进入中标审批');
  const ws = rfqResumed.checkpoint.workspace;
  const quotes = (ws['parsedQuotes'] as { quotes: { supplierId: string; unitPrice: number; deliveryDays: number }[] }).quotes;
  info(`收到 2 家报价 → 事件恢复 → 报价解析：${JSON.stringify(quotes)}`);
  info(`比价推荐中标供应商: ${String(ws['recommendedSupplier'])}（最低价）`);
  const rfqApproval = hub.approvals.listPending().find((a) => a.taskId === rfqTask.id);
  if (!rfqApproval) throw new Error('缺 RFQ 审批请求');
  await engine.approve(rfqTask.id, rfqApproval.id, humans.manager.id);
  const rfqDone = hub.machine.get(rfqTask.id);
  assert.equal(rfqDone?.status, 'completed');
  info(`✅ completed → RFQ ${rfqBo.id} 中标：${String(erp.rfqs.get('rfq:2001')?.awardedTo)}`);

  // ---------------------------------------------------------------- ④-⑦ 采购订单运营员工（核心）· 订单确认 / 供应商跟进 / 异常处理 / 系统同步
  section(log, '④ 采购订单运营员工 — 订单运营主链（确认 → 催交 → 延期审批 → 回写 → 到货关闭）');
  seedSupplier(rt, { id: 's:001', name: '苏州精密五金', email: 's001@precision.cn' });
  const poBo = hub.objects.create({
    id: 'po:1001',
    type: 'po',
    status: 'sent',
    attributes: {
      supplierId: 's:001',
      supplierName: '苏州精密五金',
      item: '铝合金外壳',
      qty: 5000,
      unitPrice: 12.5,
      promiseDate: '2025-08-25',
      poDate: '2025-08-18',
    },
  });
  syncObjectToContext(rt, poBo);
  erp.pos.set('po:1001', {
    id: 'po:1001',
    item: '铝合金外壳',
    qty: 5000,
    unitPrice: 12.5,
    promiseDate: '2025-08-25',
    status: 'sent',
    poDate: '2025-08-18',
  });
  const poTask = await engine.runTask({
    tenantId: TENANT_ID,
    employeeId: employees.procurement.id,
    workflowId: 'po-operations',
    businessObjectId: poBo.id,
  });
  assert.equal(poTask.status, 'waiting_external', '应等待供应商确认');
  info(`任务 ${poTask.id} → ${poTask.status}（PO-1001 已核对，等待供应商确认交期）`);

  section(log, '⑥ Run Plane — 恢复：供应商确认交期');
  seedSupplierEmail(rt, {
    from: 's001@precision.cn',
    subject: 'PO-1001 交期确认',
    body: '已收到 PO-1001，新交期确认为 2025-09-05，请知悉。',
    eventType: 'supplier_confirmed',
    objectId: poBo.id,
  });
  const poResumed = await waitForStatus(
    rt,
    poTask.id,
    (t) => t.status === 'waiting_approval' || t.status === 'completed' || t.status === 'failed',
    '等待供应商确认事件',
    WAIT_MS,
  );
  assert.equal(poResumed.status, 'waiting_approval', '延期超过 7 天应进入审批');
  const delay = poResumed.checkpoint.workspace['delay'] as {
    delayed: boolean;
    days: number;
    baseline: string;
    newDate: string;
  };
  info(`交期解析: 原承诺 ${delay.baseline} → 供应商确认 ${delay.newDate}，延期 ${delay.days} 天`);
  info(`延期 ${delay.days} 天 > 7 天 → ${poResumed.status}（审批规则 delay-over-7d 触发）`);

  section(log, '⑦ Governance — 人工审批（延期 > 7 天）');
  const poApproval = hub.approvals.listPending().find((a) => a.taskId === poTask.id);
  if (!poApproval) throw new Error('缺 PO 审批请求');
  info(`审批请求「${poApproval.title}」payload=${JSON.stringify(poApproval.payload)} → ${humans.manager.name} 批准`);
  await engine.approve(poTask.id, poApproval.id, humans.manager.id);
  await waitForStatus(rt, poTask.id, (t) => t.status === 'waiting_external', '审批后继续执行', WAIT_MS);
  const poNow = erp.pos.get('po:1001');
  info(`审批通过 → 引擎继续执行：ERP 承诺交期已更新为 ${String(poNow?.['promiseDate'])}`);
  const emailTool = rt.tools.get('email');
  const outbox = await emailTool?.execute('outbox.list', {}, { employeeId: employees.procurement.id });
  const sent = ((outbox?.data?.['messages'] as { subject: string }[] | undefined) ?? []).filter((m) =>
    m.subject.includes('延期跟进'),
  );
  info(`催交邮件已发送 ×${sent.length}：${sent.map((m) => m.subject).join('、') || '（无）'}`);
  info(`任务 → ${hub.machine.get(poTask.id)?.status}（等待到货）`);

  section(log, '⑧ Run Plane — 恢复：到货 → 完成');
  seedGoodsReceived(rt, poBo.id);
  const poDone = await waitForStatus(rt, poTask.id, (t) => t.status === 'completed', '等待到货事件', WAIT_MS);
  assert.equal(poDone.status, 'completed');
  info(`PO-1001 最终状态: ${String(erp.pos.get('po:1001')?.['status'])}，PO 台账已登记（Excel appendRow）`);
  info(`✅ 任务 ${poDone.id} → completed（onTime=${String(poDone.metadata.onTime)} — 延期交付，非准时）`);

  // ---------------------------------------------------------------- ⑨ 评测与控制塔
  section(log, '⑨ Control Plane — 评测（Evals）与控制塔');
  const detail = tower.employeeDetail(employees.procurement.id);
  const fmt = (x: number) => `${(x * 100).toFixed(0)}%`;
  info(`KPI 卡「${detail.spec.name}」（经理: ${humans.manager.name}）`);
  info(`  任务成功率   ${fmt(detail.kpi.successRate)}   （${detail.stats.tasksCompleted}/${detail.stats.tasksTotal}）`);
  info(`  人工介入率   ${fmt(detail.kpi.interventionRate)}   （${detail.stats.humanTakeovers} 次人工审批/接管）`);
  info(`  准时交付率   ${fmt(detail.kpi.onTimeRate)}   （延期经审批放行，记为非准时）`);
  info(`  本月成本     ¥${detail.kpi.totalCost.toFixed(2)} / 预算 ¥${detail.spec.budget?.monthlyCap}`);
  const overview = tower.overview();
  info(`员工总览: 共 ${overview.employees.total} 人 → ${JSON.stringify(overview.employees.byStatus)}`);
  info(`任务总览: 共 ${overview.tasks.total} 个 → ${JSON.stringify(overview.tasks.byStatus)}`);

  // ---------------------------------------------------------------- ⑩ 事件流
  section(log, '⑩ 验证链全部通过 ✅');
  info('创建员工 → 给权限 → 给业务任务 → AI执行 → 等待 → 恢复 → 调工具 → 人工审批 → 完成 → 评测');
  log('\n  任务事件流（节选）:');
  for (const e of hub.eventLog.filter((ev) => ev.type.startsWith('task.'))) {
    const taskId = 'taskId' in e ? String((e as { taskId?: string }).taskId ?? '').slice(0, 14) : '';
    log(`    ${e.at.slice(11, 19)}  ${e.type.padEnd(26)} ${taskId}`);
  }

  return { overview, eventLog: hub.eventLog };
}
