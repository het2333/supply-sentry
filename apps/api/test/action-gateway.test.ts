import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createSupplyChainRuntime, TENANT_ID } from '@readywork/supply-chain';
import { ActionGateway, type ActionConnectorPort } from '../src/action-gateway.js';
import type { EditorNodeDef } from '../src/editor.js';

const mailNode = {
  id: 'node:mail',
  kind: 'tool',
  name: '发送供应商邮件',
  label: '邮件询价',
  detail: '发送询价邮件',
  type: 'connector.email.send_supplier_email',
  typeVersion: 1,
  inputs: [],
  outputs: [],
} as EditorNodeDef;

const invoiceWriteNode = {
  id: 'node:invoice-write',
  kind: 'tool',
  name: 'ERP回写应付结果',
  label: 'ERP回写应付结果',
  detail: '将已审核的应付结果回写 ERP',
  type: 'connector.erp.action',
  typeVersion: 1,
  inputs: [],
  outputs: [],
  parameters: { action: 'invoice.update' },
  config: { action: 'invoice.update' },
  sideEffects: ['写 ERP'],
} as EditorNodeDef;

/**
 * 发票 / 应付已经从 Navisight post-PO V1 拆出；这些 ActionGateway 回归仍需
 * 用隔离的测试 Spec 验证旧 AP 节点的安全参数和不确定写入处理。
 */
function enableLegacyInvoiceUpdateForGatewayTest(runtime: ReturnType<typeof createSupplyChainRuntime>): void {
  const employee = runtime.employees.procurement;
  const spec = runtime.hub.specs.get(employee.specId)!;
  runtime.hub.specs.register({
    ...spec,
    permissions: [...spec.permissions, { effect: 'allow', action: 'invoice.update', resource: 'erp', note: '仅用于旧 AP Gateway 回归' }],
  });
}

test('ActionGateway: 并发请求只执行一次真实副作用', async () => {
  const db = new DatabaseSync(':memory:');
  const runtime = createSupplyChainRuntime();
  let externalCalls = 0;
  const connectors: ActionConnectorPort = {
    execute: async () => {
      externalCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, output: { messageId: 'mail:1' } };
    },
    getCredential: () => undefined,
  };
  const gateway = new ActionGateway(db, runtime.hub, runtime.context, connectors);
  const request = {
    runId: 'run:idempotent', tenantId: TENANT_ID, employeeId: runtime.employees.procurement.id,
    node: mailNode, input: { to: 'supplier@example.com', subject: '询价', body: '请报价' }, mode: 'autonomous' as const,
  };

  const results = await Promise.all(Array.from({ length: 8 }, () => gateway.execute(request)));
  assert.equal(externalCalls, 1);
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(results.filter((result) => result.replayed).length, 7);
  assert.equal((await gateway.execute(request)).replayed, true);
  assert.equal(externalCalls, 1);
  db.close();
});

test('ActionGateway: 幂等键按租户隔离，租户与员工不匹配时绝不执行副作用', async () => {
  const db = new DatabaseSync(':memory:');
  const runtime = createSupplyChainRuntime();
  const tenantB = 'tenant:action-b';
  const tenantBEmployee = 'ai:action-b';
  runtime.hub.org.registerAI({
    ...runtime.employees.procurement,
    id: tenantBEmployee,
    tenantId: tenantB,
  });
  let externalCalls = 0;
  const connectors: ActionConnectorPort = {
    execute: async () => { externalCalls += 1; return { ok: true, output: {} }; },
    getCredential: () => undefined,
  };
  const gateway = new ActionGateway(db, runtime.hub, runtime.context, connectors);
  const input = { node: mailNode, input: { to: 'supplier@example.com', subject: '询价', body: '请报价' }, mode: 'autonomous' as const };

  const [first, second] = await Promise.all([
    gateway.execute({ ...input, runId: 'run:shared', tenantId: TENANT_ID, employeeId: runtime.employees.procurement.id }),
    gateway.execute({ ...input, runId: 'run:shared', tenantId: tenantB, employeeId: tenantBEmployee }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(externalCalls, 2);

  await assert.rejects(
    () => gateway.execute({ ...input, runId: 'run:wrong-tenant', tenantId: tenantB, employeeId: runtime.employees.procurement.id }),
    /租户不一致/,
  );
  assert.equal(externalCalls, 2);
  db.close();
});

test('ActionGateway: 连接器错误与输出中的敏感字段会被脱敏', async () => {
  const runtime = createSupplyChainRuntime();
  let fail = false;
  const connectors: ActionConnectorPort = {
    execute: async () => {
      if (fail) throw new Error('password=secret-value token=abc.def');
      return { ok: true, output: { apiKey: 'secret-value', nested: { authorization: 'Bearer abc.def' } } };
    },
    getCredential: () => undefined,
  };
  const gateway = new ActionGateway(undefined, runtime.hub, runtime.context, connectors);
  const base = { tenantId: TENANT_ID, employeeId: runtime.employees.procurement.id, node: mailNode, input: { to: 'supplier@example.com', subject: '询价', body: '请报价' }, mode: 'autonomous' as const };
  const success = await gateway.execute({ ...base, runId: 'run:redact-output' });
  assert.deepEqual(success.output, { apiKey: '[REDACTED]', nested: { authorization: '[REDACTED]' } });
  fail = true;
  const failed = await gateway.execute({ ...base, runId: 'run:redact-error' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error?.includes('secret-value'), false);
  assert.equal(failed.error?.includes('abc.def'), false);
});

test('ActionGateway: ERP 动作只取冻结节点参数，发票升级回写保留业务字段', async () => {
  const runtime = createSupplyChainRuntime();
  enableLegacyInvoiceUpdateForGatewayTest(runtime);
  let action = '';
  let args: Record<string, unknown> = {};
  const connectors: ActionConnectorPort = {
    execute: async (_connector, nextAction, nextArgs) => {
      action = nextAction;
      args = nextArgs;
      return { ok: true, output: { invoice: { id: nextArgs['invoiceId'] } } };
    },
    getCredential: () => undefined,
  };
  const gateway = new ActionGateway(undefined, runtime.hub, runtime.context, connectors);
  const result = await gateway.execute({
    runId: 'run:invoice-upgrade', tenantId: TENANT_ID, employeeId: runtime.employees.procurement.id, node: invoiceWriteNode,
    // action 来自工作流输入时必须被忽略，不能把 invoice.update 改成 po.update。
    input: { invoiceId: 42, disposition: 'exact_match', action: 'po.update' }, mode: 'autonomous',
  });
  assert.equal(result.ok, true);
  assert.equal(action, 'invoice.update');
  assert.deepEqual(args, { invoiceId: 42, matchResult: 'exact_match', payableStatus: 'payable' });
});

test('ActionGateway: 严重三单异常即使误连 ERP 节点也只能写 hold', async () => {
  const runtime = createSupplyChainRuntime();
  enableLegacyInvoiceUpdateForGatewayTest(runtime);
  let args: Record<string, unknown> = {};
  const connectors: ActionConnectorPort = {
    execute: async (_connector, _action, nextArgs) => { args = nextArgs; return { ok: true, output: {} }; },
    getCredential: () => undefined,
  };
  const gateway = new ActionGateway(undefined, runtime.hub, runtime.context, connectors);
  await gateway.execute({
    runId: 'run:invoice-severe', tenantId: TENANT_ID, employeeId: runtime.employees.procurement.id, node: invoiceWriteNode,
    input: { invoiceId: 42, disposition: 'severe_exception', payableStatus: 'payable' }, mode: 'autonomous',
  });
  assert.equal(args['payableStatus'], 'hold');
  assert.equal(args['holdReason'], '三单匹配严重异常，等待人工处理');
});

test('ActionGateway: 需审批的匹配结果只有 Temporal 私有审批审计存在时才可标记 payable', async () => {
  const runtime = createSupplyChainRuntime();
  enableLegacyInvoiceUpdateForGatewayTest(runtime);
  const connectors: ActionConnectorPort = {
    execute: async () => ({ ok: true, output: {} }),
    getCredential: () => undefined,
  };
  const gateway = new ActionGateway(undefined, runtime.hub, runtime.context, connectors);
  const base = { tenantId: TENANT_ID, employeeId: runtime.employees.procurement.id, node: invoiceWriteNode, mode: 'autonomous' as const };
  await assert.rejects(
    () => gateway.execute({ ...base, runId: 'run:approval-missing', input: { invoiceId: 42, disposition: 'approval_required' } }),
    /缺少当前审批绑定的已批准结论/,
  );
  const result = await gateway.execute({
    ...base,
    runId: 'run:approval-granted',
    input: { invoiceId: 42, disposition: 'approval_required', __readyworkApprovalAudit: [{ nodeId: 'appr:tw', decisionId: 'decision:42', decision: 'approved' }] },
  });
  assert.equal(result.ok, true);
});

test('ActionGateway: 过期 ERP 预留先核验，无法确认时进入人工对账且不重放', async () => {
  const db = new DatabaseSync(':memory:');
  const runtime = createSupplyChainRuntime();
  enableLegacyInvoiceUpdateForGatewayTest(runtime);
  let executeCalls = 0;
  let reconcileCalls = 0;
  const connectors: ActionConnectorPort = {
    execute: async () => { executeCalls += 1; return { ok: true, output: {} }; },
    reconcile: async () => { reconcileCalls += 1; return { confirmed: false }; },
    getCredential: () => undefined,
  };
  const gateway = new ActionGateway(db, runtime.hub, runtime.context, connectors);
  const key = 'run:expired:node:invoice-write:erp.invoice.update';
  db.prepare("INSERT INTO action_executions (tenant_id,idempotency_key,run_id,node_id,status,json,created_at,lease_expires_at,attempt,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(TENANT_ID, key, 'run:expired', invoiceWriteNode.id, 'pending', JSON.stringify({ ok: false }), new Date(0).toISOString(), new Date(0).toISOString(), 1, new Date(0).toISOString());
  const result = await gateway.execute({
    runId: 'run:expired', tenantId: TENANT_ID, employeeId: runtime.employees.procurement.id, node: invoiceWriteNode,
    input: { invoiceId: 42, disposition: 'exact_match' }, mode: 'autonomous',
  });
  assert.equal(result.ok, false);
  assert.equal(result.recoveryState, 'manual_reconciliation');
  assert.equal(reconcileCalls, 1);
  assert.equal(executeCalls, 0);
  const replay = await gateway.execute({ runId: 'run:expired', tenantId: TENANT_ID, employeeId: runtime.employees.procurement.id, node: invoiceWriteNode, input: { invoiceId: 42, disposition: 'exact_match' }, mode: 'autonomous' });
  assert.equal(replay.replayed, true);
  db.close();
});

test('ActionGateway: ERP 超时后的结果先核验；不能确认时不泄露错误且不重放', async () => {
  const runtime = createSupplyChainRuntime();
  enableLegacyInvoiceUpdateForGatewayTest(runtime);
  let executeCalls = 0;
  let reconcileCalls = 0;
  const connectors: ActionConnectorPort = {
    execute: async () => {
      executeCalls += 1;
      throw new Error('AbortError: request timeout token=secret-value');
    },
    reconcile: async () => { reconcileCalls += 1; return { confirmed: false }; },
    getCredential: () => undefined,
  };
  const gateway = new ActionGateway(undefined, runtime.hub, runtime.context, connectors);
  const request = {
    runId: 'run:invoice-timeout', tenantId: TENANT_ID, employeeId: runtime.employees.procurement.id, node: invoiceWriteNode,
    input: { invoiceId: 42, disposition: 'exact_match' }, mode: 'autonomous' as const,
  };
  const result = await gateway.execute(request);
  assert.equal(result.ok, false);
  assert.equal(result.recoveryState, 'manual_reconciliation');
  assert.equal(result.error?.includes('secret-value'), false);
  assert.equal(executeCalls, 1);
  assert.equal(reconcileCalls, 1);
  const replay = await gateway.execute(request);
  assert.equal(replay.replayed, true);
  assert.equal(executeCalls, 1);
});

test('ActionGateway: 只有明确未连上外部系统的错误才按节点配置真实重试', async () => {
  const db = new DatabaseSync(':memory:');
  const runtime = createSupplyChainRuntime();
  let executeCalls = 0;
  const connectors: ActionConnectorPort = {
    execute: async () => {
      executeCalls += 1;
      if (executeCalls === 1) return { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:465 password=secret-value' };
      return { ok: true, output: { messageId: 'mail:retry-success' } };
    },
    getCredential: () => undefined,
  };
  const gateway = new ActionGateway(db, runtime.hub, runtime.context, connectors);
  const request = {
    runId: 'run:safe-retry', tenantId: TENANT_ID, employeeId: runtime.employees.procurement.id,
    node: { ...mailNode, retries: 2 }, input: { to: 'supplier@example.com', subject: '询价', body: '请报价' }, mode: 'autonomous' as const,
  };
  const first = await gateway.execute(request);
  assert.equal(first.ok, false);
  assert.equal(first.retryable, true);
  assert.equal(first.error?.includes('secret-value'), false);
  const second = await gateway.execute(request);
  assert.equal(second.ok, true);
  assert.equal(executeCalls, 2);
  assert.equal((await gateway.execute(request)).replayed, true);
  assert.equal(executeCalls, 2);
  db.close();
});

test('ActionGateway: 邮件发送超时视为结果不确定，转人工对账而不重复发信', async () => {
  const db = new DatabaseSync(':memory:');
  const runtime = createSupplyChainRuntime();
  let executeCalls = 0;
  const connectors: ActionConnectorPort = {
    execute: async () => { executeCalls += 1; return { ok: false, error: 'SMTP 整体超时 token=secret-value' }; },
    getCredential: () => undefined,
  };
  const gateway = new ActionGateway(db, runtime.hub, runtime.context, connectors);
  const request = {
    runId: 'run:mail-timeout', tenantId: TENANT_ID, employeeId: runtime.employees.procurement.id,
    node: { ...mailNode, retries: 2 }, input: { to: 'supplier@example.com', subject: '询价', body: '请报价' }, mode: 'autonomous' as const,
  };
  const first = await gateway.execute(request);
  assert.equal(first.recoveryState, 'manual_reconciliation');
  assert.equal(first.error?.includes('secret-value'), false);
  const replay = await gateway.execute(request);
  assert.equal(replay.replayed, true);
  assert.equal(executeCalls, 1);
  db.close();
});
