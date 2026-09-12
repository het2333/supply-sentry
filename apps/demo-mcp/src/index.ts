import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekHarnessAdapter } from '@readywork/agent';
import { createBridgeServer } from '@readywork/app-mcp-bridge';
import { createMockModelServer } from '@readywork/app-mock-model';
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
 * MCP 工具桥验证：DSH agent 经 MCP **原生调用**我们的工具（而非 JSON 决策）。
 * 场景：PO 延期处理 —— agent 调用 mcp__rw__skill__compose_follow_up → mcp__rw__email__send，
 * 工具在**我们的进程**执行（同一份状态 + 权限 + 记账），结果回灌给 agent。
 */

const BANNER = `
╔══════════════════════════════════════════════════════════════════╗
║   readywork — V2.0 MCP 工具桥验证                                 ║
║   ToolRegistry/SkillRegistry 暴露为 DSH Tool（原生 tool-calling） ║
╚══════════════════════════════════════════════════════════════════╝`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitStatus(rt: ReturnType<typeof createSupplyChainRuntime>, taskId: string, pred: (s: string) => boolean) {
  for (let i = 0; i < 600; i++) {
    const t = rt.hub.machine.get(taskId)!;
    if (pred(t.status)) return t;
    await sleep(25);
  }
  throw new Error(`等待状态超时: ${rt.hub.machine.get(taskId)?.status}（error=${rt.hub.machine.get(taskId)?.error}）`);
}

async function main(): Promise<void> {
  console.log(BANNER);
  const repo = process.env['DSH_REPO'] ?? '/Users/etheralia/Downloads/deepseek-harness-master';
  const repoRoot = process.cwd();
  const workspace = mkdtempSync(join(tmpdir(), 'rw-mcp-'));

  // ① mock 模型（mcp 模式：产出原生 tool_calls）
  const mock = await createMockModelServer({ mode: 'mcp', logger: (l) => console.log('      ', l) });

  // ② 供应链运行时（hub/tools/skills 与工作流）
  const rt = createSupplyChainRuntime();
  const { hub, engine, employees, humans } = rt;
  const erp = erpOf(rt);

  // ③ MCP 工具桥（主进程执行器）
  const bridge = await createBridgeServer({ hub, tools: rt.tools, skills: rt.skills, logger: (l) => console.log('      ', l) });
  console.log(`  MCP 桥接器: ${bridge.url}（tools=${rt.tools.list().length}，skills=${rt.skills.list().length}）`);

  // ④ DeepSeek Harness Adapter：每员工一个 runtime，MCP 绑定员工身份
  const toolCalls: string[] = [];
  const adapter = new DeepSeekHarnessAdapter({
    runtimeFactory: (employeeId) => ({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        join(repo, 'packages/examples/jsonrpc-demo/src/bin.ts'),
        join(repoRoot, 'apps/mcp-bridge/cordis.mcp.yml'),
      ],
      cwd: repo,
      env: {
        DEEPSEEK_API_KEY: 'demo-mock-key',
        DEEPSEEK_BASE_URL: mock.url,
        DSH_CWD: workspace,
        DSH_SESSION_ROOT: join(workspace, '.sessions'),
        RW_BRIDGE_URL: bridge.url,
        RW_BRIDGE_TOKEN: bridge.token,
        RW_EMPLOYEE_ID: employeeId,
        RW_MCP_NODE: process.execPath,
        RW_MCP_SERVER: join(repoRoot, 'apps/mcp-bridge/src/server.ts'),
      },
      model: 'deepseek-v4-flash',
      initializeTimeoutMs: 180_000,
      turnTimeoutMs: 180_000,
    }),
    onEvents: (_employeeId, events) => {
      for (const e of events) {
        const ev = e as { type?: string; data?: { name?: string; arguments?: unknown } };
        if (ev?.type === 'tool/call') {
          toolCalls.push(String(ev.data?.name ?? ''));
          console.log(`        ↳ DSH tool/call: ${String(ev.data?.name)}(${JSON.stringify(ev.data?.arguments).slice(0, 80)})`);
        }
      }
    },
    logger: (l) => console.log('      ', l),
  });
  rt.engine.setAgent(adapter);

  // ⑤ 跑 PO 场景（延期 11 天 → 审批 → MCP 原生催交 → 到货 → 完成）
  console.log('\n  ── PO 延期处理场景 ──');
  seedSupplier(rt, { id: 's:001', name: '苏州精密五金', email: 's001@precision.cn' });
  erp.pos.set('po:1001', { id: 'po:1001', item: '铝合金外壳', qty: 5000, unitPrice: 12.5, promiseDate: '2025-08-25', status: 'sent' });
  const poBo = hub.objects.create({
    id: 'po:1001',
    type: 'po',
    status: 'sent',
    attributes: { supplierId: 's:001', supplierName: '苏州精密五金', item: '铝合金外壳', qty: 5000, unitPrice: 12.5, promiseDate: '2025-08-25', poDate: '2025-08-18' },
  });
  syncObjectToContext(rt, poBo);
  const task = await engine.runTask({ tenantId: TENANT_ID, employeeId: employees.procurement.id, workflowId: 'po-operations', businessObjectId: poBo.id });
  await waitStatus(rt, task.id, (s) => s === 'waiting_external');
  seedSupplierEmail(rt, {
    from: 's001@precision.cn',
    subject: 'PO-1001 交期确认',
    body: '已收到 PO-1001，新交期确认为 2025-09-05，请知悉。',
    eventType: 'supplier_confirmed',
    objectId: poBo.id,
  });
  await waitStatus(rt, task.id, (s) => s === 'waiting_approval');
  const approval = hub.approvals.listPending().find((a) => a.taskId === task.id);
  assert.ok(approval, '延期>7天应进入审批');
  await engine.approve(task.id, approval.id, humans.manager.id);
  await waitStatus(rt, task.id, (s) => s === 'waiting_external');
  console.log('  审批通过 → agent 经 MCP 原生调用技能/工具处理延期...');
  await sleep(200);

  // ⑥ 断言：邮件工具被原生调用（发件箱出现催交邮件）
  const emailTool = rt.tools.get('email');
  const outbox = await emailTool?.execute('outbox.list', {}, { employeeId: employees.procurement.id });
  const sent = ((outbox?.data?.['messages'] as { subject: string }[] | undefined) ?? []).filter((m) => m.subject.includes('延期跟进'));
  assert.ok(sent.length >= 1, '应通过 MCP 原生调用发送催交邮件');
  console.log(`  ✅ 催交邮件已发送 ×${sent.length}：${sent.map((m) => m.subject).join('、')}`);
  assert.ok(toolCalls.some((n) => n.includes('compose_follow_up')), '应观察到 skill__compose_follow_up 的 tool/call');
  assert.ok(toolCalls.some((n) => n.includes('email__send')), '应观察到 email__send 的 tool/call');
  console.log(`  ✅ 观察到原生 tool/call: ${toolCalls.join(' → ')}`);

  // ⑦ 到货 → 完成
  seedGoodsReceived(rt, poBo.id);
  await waitStatus(rt, task.id, (s) => s === 'completed');
  const ws = hub.machine.get(task.id)!.checkpoint.workspace;
  console.log(`  ✅ 任务完成（followup 步骤 stateUpdates.mcpTools=${JSON.stringify(ws['mcpTools'] ?? ws['agent.last'])})`);
  console.log(`  mock-model 请求数: ${mock.requestCount()}（多轮 tool-calling）`);

  await adapter.close().catch(() => {});
  await bridge.close().catch(() => {});
  await mock.close().catch(() => {});
  console.log('\n  完成 — MCP 工具桥验证通过 ✅（agent 原生调用我们的工具，权限/记账仍在本进程）');
}

void main().catch((err) => {
  console.error('\n❌ MCP 验证失败:', err);
  process.exit(1);
});
