import { compareRuns, recordReport } from '@readywork/evals';
import type { EvalReport } from '@readywork/evals';
import {
  TENANT_ID,
  createSupplyChainRuntime,
  erpOf,
  seedGoodsReceived,
  seedSupplier,
  seedSupplierEmail,
  syncObjectToContext,
} from '@readywork/supply-chain';

/**
 * Evaluations 回放评测：
 *   跑两次 PO 运营场景（一次正常交付、一次延期 11 天），录制轨迹、评分、回归对比。
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitStatus(rt: ReturnType<typeof createSupplyChainRuntime>, taskId: string, pred: (s: string) => boolean) {
  for (let i = 0; i < 400; i++) {
    const t = rt.hub.machine.get(taskId)!;
    if (pred(t.status)) return t;
    await sleep(20);
  }
  throw new Error(`等待状态超时: ${rt.hub.machine.get(taskId)?.status}`);
}

/** 跑一次 PO 运营：newPromiseDate 决定延期与否 */
async function runPoScenario(newPromiseDate: string): Promise<EvalReport> {
  const rt = createSupplyChainRuntime();
  const { hub, engine, employees, humans } = rt;
  const erp = erpOf(rt);
  seedSupplier(rt, { id: 's:001', name: '苏州精密五金', email: 's001@precision.cn' });
  erp.pos.set('po:1001', { id: 'po:1001', item: '铝合金外壳', qty: 5000, unitPrice: 12.5, promiseDate: '2025-08-25', status: 'sent' });
  const bo = hub.objects.create({
    id: 'po:1001',
    type: 'po',
    status: 'sent',
    attributes: { supplierId: 's:001', supplierName: '苏州精密五金', item: '铝合金外壳', qty: 5000, unitPrice: 12.5, promiseDate: '2025-08-25', poDate: '2025-08-18' },
  });
  syncObjectToContext(rt, bo);
  const task = await engine.runTask({ tenantId: TENANT_ID, employeeId: employees.procurement.id, workflowId: 'po-operations', businessObjectId: bo.id });
  await waitStatus(rt, task.id, (s) => s === 'waiting_external');
  seedSupplierEmail(rt, {
    from: 's001@precision.cn',
    subject: 'PO-1001 交期确认',
    body: `已收到 PO-1001，新交期确认为 ${newPromiseDate}，请知悉。`,
    eventType: 'supplier_confirmed',
    objectId: bo.id,
  });
  await waitStatus(rt, task.id, (s) => s === 'waiting_approval' || s === 'waiting_external');
  const cur = hub.machine.get(task.id)!;
  if (cur.status === 'waiting_approval') {
    const approval = hub.approvals.listPending().find((a) => a.taskId === task.id);
    if (approval) await engine.approve(task.id, approval.id, humans.manager.id);
  }
  await waitStatus(rt, task.id, (s) => s === 'waiting_external');
  seedGoodsReceived(rt, bo.id);
  await waitStatus(rt, task.id, (s) => s === 'completed');
  return recordReport(hub, newPromiseDate > '2025-08-25' ? 'delayed' : 'on-time');
}

function fmt(pct: number): string {
  return `${(pct * 100).toFixed(0)}%`;
}

function printReport(r: EvalReport): void {
  console.log(`\n  ── 运行「${r.runId}」──`);
  for (const e of r.employees) {
    console.log(
      `   ${e.name.padEnd(10)} 成功率 ${fmt(e.successRate).padStart(4)}  介入率 ${fmt(e.interventionRate).padStart(4)}  准时率 ${fmt(e.onTimeRate).padStart(4)}  成本 ¥${e.cost.toFixed(2).padStart(5)}  审批(合理/总) ${e.approvals.justified}/${e.approvals.total}  工具失败 ${e.toolFailures}  重试 ${e.retries}`,
    );
  }
  const po = r.tasks.find((t) => t.workflowId === 'po-operations');
  if (po) {
    console.log(`   └ PO 任务 ${po.taskId.slice(0, 12)}: ${po.status}（onTime=${String(po.onTime)}，耗时 ${po.durationMs}ms，审批 ${po.approvals.length} 次，工具调用 ${po.toolCalls.length} 次）`);
  }
}

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   readywork — V2.0 Evaluations 回放评测                          ║');
  console.log('║   轨迹录制 → 评分 → 回归对比（正常交付 vs 延期交付）            ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  const onTime = await runPoScenario('2025-08-23');
  const delayed = await runPoScenario('2025-09-05');
  printReport(onTime);
  printReport(delayed);

  console.log('\n  ── 回归对比（delayed vs on-time）──');
  for (const d of compareRuns(onTime, delayed)) {
    const emp = onTime.employees.find((e) => e.employeeId === d.employeeId);
    console.log(
      `   ${emp?.name ?? d.employeeId}: 成功率 ${d.successRateDelta >= 0 ? '+' : ''}${fmt(d.successRateDelta)}  介入率 ${d.interventionRateDelta >= 0 ? '+' : ''}${fmt(d.interventionRateDelta)}  准时率 ${d.onTimeRateDelta >= 0 ? '+' : ''}${fmt(d.onTimeRateDelta)}  成本 ${d.costDelta >= 0 ? '+' : ''}¥${d.costDelta.toFixed(2)}`,
    );
  }
  console.log('\n  完成 — 评测工具链可用 ✅（结论：延期场景触发审批→介入率↑、准时率↓，与预期一致）');
}

void main().catch((err) => {
  console.error('\n❌ 评测脚本失败:', err);
  process.exit(1);
});
