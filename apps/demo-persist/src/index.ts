import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TENANT_ID,
  createSupplyChainRuntime,
  erpOf,
  seedGoodsReceived,
  seedSupplier,
  seedSupplierEmail,
  syncObjectToContext,
} from '@readywork/supply-chain';
import {
  attachPersistence,
  createPersistentRuntimeHub,
  openPersistence,
  persistOrg,
  restoreOrgState,
} from '@readywork/persistence';
import type { PersistenceStore } from '@readywork/persistence';

/**
 * 持久化与崩溃恢复演示：
 *   第一次运行：PO 任务推进到"等待供应商确认"后"崩溃"（关闭数据库）
 *   重启：任务/事件/员工状态全部恢复 → 重新武装事件恢复 → 供应商确认 → 审批 → 到货 → 完成
 *   额外演示：中断任务（重启时仍 running）被标记 failed
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const BANNER = `
╔══════════════════════════════════════════════════════════════════╗
║   readywork — V2.0 持久化与崩溃恢复（node:sqlite 零依赖）          ║
║   Task / BusinessObject / Approval / Event / Org / Budget 落盘    ║
╚══════════════════════════════════════════════════════════════════╝`;

function bootRuntime(store: PersistenceStore) {
  const hub = createPersistentRuntimeHub(store);
  const rt = createSupplyChainRuntime({ hub });
  persistOrg(store, hub);
  attachPersistence(store, hub);
  return rt;
}

async function phase1(dbPath: string): Promise<void> {
  console.log('\n────── 第一次运行 ──────');
  const store = openPersistence(dbPath);
  const rt = bootRuntime(store);
  const { hub, engine, employees, humans } = rt;
  const erp = erpOf(rt);

  seedSupplier(rt, { id: 's:001', name: '苏州精密五金', email: 's001@precision.cn' });
  erp.pos.set('po:1001', {
    id: 'po:1001',
    item: '铝合金外壳',
    qty: 5000,
    unitPrice: 12.5,
    promiseDate: '2025-08-25',
    status: 'sent',
    poDate: '2025-08-18',
  });
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

  const task = await engine.runTask({
    tenantId: TENANT_ID,
    employeeId: employees.procurement.id,
    workflowId: 'po-operations',
    businessObjectId: poBo.id,
  });
  assert.equal(task.status, 'waiting_external');
  console.log(`  PO 任务 ${task.id} → ${task.status}（等待供应商确认）`);

  // 模拟一个"执行到一半崩溃"的任务（直接置为 running 后退出）
  const crash = hub.machine.create({ tenantId: TENANT_ID, employeeId: employees.procurement.id, workflowId: 'rfq-process', businessObjectId: poBo.id });
  hub.machine.start(crash.id);
  console.log(`  中断任务 ${crash.id} → running（模拟执行到一半崩溃）`);
  console.log(`  [崩溃] 进程退出，数据库关闭...`);
  hub.scheduler.cancelAll(); // 定时器随进程消亡
  store.close();
}

async function phase2(dbPath: string): Promise<void> {
  console.log('\n────── 重启恢复 ──────');
  const store = openPersistence(dbPath);
  const rt = bootRuntime(store);
  const { hub, engine, tower, employees, humans } = rt;
  const erp = erpOf(rt);

  // ① 任务/事件/审批恢复
  const tasks = hub.machine.list();
  const poTask = tasks.find((t) => t.workflowId === 'po-operations');
  assert.ok(poTask, 'PO 任务应跨重启保留');
  assert.equal(poTask.status, 'waiting_external', '等待中任务应保持挂起状态');
  const interrupted = tasks.filter((t) => t.error?.includes('进程中断'));
  assert.ok(interrupted.length >= 1, '中断任务应被标记 failed');
  console.log(`  任务恢复: ${tasks.length} 个（waiting_external ${tasks.filter((t) => t.status === 'waiting_external').length}，failed(进程中断) ${interrupted.length}）`);
  console.log(`  事件日志恢复: ${store.events.list().length} 条（控制塔可见 ${hub.eventLog.length} 条）`);

  // ①b 重连外部系统：从持久化的业务对象重建 ERP 内存态（真实场景=重连 SAP/金蝶等连接器）
  for (const bo of hub.objects.list()) {
    if (bo.type === 'po') {
      erp.pos.set(bo.id, { ...bo.attributes, id: bo.id, status: bo.attributes['status'] ?? bo.status });
    }
  }
  console.log(`  ERP 重连: 从持久化业务对象恢复 ${hub.objects.list().filter((b) => b.type === 'po').length} 个 PO`);

  // ② 员工状态恢复
  const restored = restoreOrgState(store, hub);
  const emp = hub.org.getAI(employees.procurement.id);
  assert.ok(emp);
  console.log(`  员工状态恢复: ${restored} 人（${emp.name} → ${emp.status}）`);

  // ③ 重新武装事件恢复
  const rearmed = rt.engine.rearmWaits();
  assert.equal(rearmed, 1, '应重新武装 1 个等待事件');
  console.log(`  事件恢复重新武装: ${rearmed} 个等待任务`);

  // ④ 业务事件到达 → 任务继续（审批 → 更新交期 → 催交 → 到货 → 完成）
  seedSupplierEmail(rt, {
    from: 's001@precision.cn',
    subject: 'PO-1001 交期确认',
    body: '已收到 PO-1001，新交期确认为 2025-09-05，请知悉。',
    eventType: 'supplier_confirmed',
    objectId: 'po:1001',
  });
  for (let i = 0; i < 200; i++) {
    await sleep(25);
    const t = hub.machine.get(poTask.id)!;
    if (t.status === 'waiting_approval') break;
  }
  const resumed = hub.machine.get(poTask.id)!;
  assert.equal(resumed.status, 'waiting_approval', '延期>7天应进入审批');
  const delay = resumed.checkpoint.workspace['delay'] as { days: number };
  console.log(`  供应商确认 → 延期 ${delay.days} 天 → ${resumed.status}`);
  const approval = hub.approvals.listPending().find((a) => a.taskId === poTask.id);
  assert.ok(approval, '审批请求应跨重启保留');
  await engine.approve(poTask.id, approval.id, humans.manager.id);
  await sleep(150);
  seedGoodsReceived(rt, 'po:1001');
  for (let i = 0; i < 200; i++) {
    await sleep(25);
    if (hub.machine.get(poTask.id)?.status === 'completed') break;
  }
  assert.equal(hub.machine.get(poTask.id)?.status, 'completed');
  console.log(`  审批 → 更新交期 → 催交 → 到货 → completed`);
  console.log(`  ERP 最终状态: ${String(erp.pos.get('po:1001')?.['status'])}（承诺交期 ${String(erp.pos.get('po:1001')?.['promiseDate'])}）`);

  // ⑤ 统计与 KPI 一致性
  const detail = tower.employeeDetail(employees.procurement.id);
  console.log(`  恢复后 KPI: 成功率 ${(detail.kpi.successRate * 100).toFixed(0)}%，介入率 ${(detail.kpi.interventionRate * 100).toFixed(0)}%，成本 ¥${detail.kpi.totalCost.toFixed(2)}`);

  // ⑥ 再次"重启"验证统计已落盘
  console.log('\n────── 第二次重启（验证统计持久化）──────');
  store.close();
  const store3 = openPersistence(dbPath);
  const rt3 = bootRuntime(store3);
  restoreOrgState(store3, rt3.hub);
  const detail3 = rt3.tower.employeeDetail(rt3.employees.procurement.id);
  assert.equal(detail3.stats.tasksCompleted, 1, '完成数应跨重启保留');
  assert.equal(detail3.stats.humanTakeovers, 1, '人工介入数应跨重启保留');
  assert.ok(detail3.kpi.totalCost > 0, '成本应跨重启保留');
  console.log(`  KPI 持久化验证: 任务完成 ${detail3.stats.tasksCompleted}，人工介入 ${detail3.stats.humanTakeovers}，成本 ¥${detail3.kpi.totalCost.toFixed(2)} ✅`);
  store3.close();
  console.log('\n  完成 — 崩溃恢复验证链全部通过 ✅');
}

async function main(): Promise<void> {
  console.log(BANNER);
  const dir = mkdtempSync(join(tmpdir(), 'rw-persist-'));
  const dbPath = join(dir, 'workforce.db');
  await phase1(dbPath);
  await phase2(dbPath);
  rmSync(dir, { recursive: true, force: true });
}

void main().catch((err) => {
  console.error('\n❌ 持久化演示失败:', err);
  process.exit(1);
});
