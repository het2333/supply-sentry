import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createSupplyChainRuntime } from '@readywork/supply-chain';
import { ActionGateway, type ActionConnectorPort } from '../src/action-gateway.js';
import type { EditorNodeDef } from '../src/editor.js';
import { PUBLIC_DEMO_TENANT_ID } from '../src/public-demo-mode.js';
import { resetPublicDemo } from '../src/public-demo-reset.js';
import { PUBLIC_DEMO_IDS } from '../src/public-demo-seed.js';

const publicDemoMailNode = {
  id: 'node:public-demo:mail',
  kind: 'tool',
  name: '发送供应商邮件',
  label: '邮件询价',
  detail: '公开演示发送询价邮件',
  type: 'connector.email.send_supplier_email',
  typeVersion: 1,
  inputs: [],
  outputs: [],
  credentialRef: 'credential:must-never-be-read',
} as EditorNodeDef;

test('ActionGateway never resolves a connector or credential for the public demo tenant', async () => {
  const db = new DatabaseSync(':memory:');
  resetPublicDemo(db, new Date('2026-09-13T04:00:00.000Z'));
  const runtime = createSupplyChainRuntime();
  const publicEmployeeId = 'ai:public-demo:procurement';
  runtime.hub.org.registerAI({
    ...runtime.employees.procurement,
    id: publicEmployeeId,
    tenantId: PUBLIC_DEMO_TENANT_ID,
  });
  let executeCalls = 0;
  let credentialReads = 0;
  const connectors: ActionConnectorPort = {
    execute: async () => {
      executeCalls += 1;
      throw new Error('a public demo request reached a real connector');
    },
    getCredential: () => {
      credentialReads += 1;
      throw new Error('a public demo request read a real credential');
    },
  };
  const gateway = new ActionGateway(db, runtime.hub, runtime.context, connectors);

  const result = await gateway.execute({
    runId: 'run:public-demo:accepted',
    tenantId: PUBLIC_DEMO_TENANT_ID,
    employeeId: publicEmployeeId,
    node: publicDemoMailNode,
    input: {
      poId: PUBLIC_DEMO_IDS.normalPo,
      to: 'supplier@example.test',
      subject: '公开演示询价',
      body: '这条消息不会离开公开演示环境。',
    },
    mode: 'autonomous',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    {
      receiptKind: (result.output as Record<string, unknown>)['receiptKind'],
      outcome: (result.output as Record<string, unknown>)['outcome'],
      externalDelivery: (result.output as Record<string, unknown>)['externalDelivery'],
      generation: (result.output as Record<string, unknown>)['generation'],
    },
    { receiptKind: 'simulated_demo', outcome: 'accepted', externalDelivery: false, generation: 1 },
  );
  assert.equal(executeCalls, 0);
  assert.equal(credentialReads, 0);

  const persisted = db.prepare(`SELECT json FROM action_executions
    WHERE tenant_id=? AND idempotency_key=?`).get(PUBLIC_DEMO_TENANT_ID, result.idempotencyKey) as { json: string } | undefined;
  assert.deepEqual(JSON.parse(persisted!.json).output, result.output);
  const audit = db.prepare(`SELECT detail_json FROM public_demo_audit
    WHERE tenant_id=? AND event_type='public_demo.external_action.simulated'`).get(PUBLIC_DEMO_TENANT_ID) as { detail_json: string } | undefined;
  assert.deepEqual(JSON.parse(audit!.detail_json).receipt, result.output);
  db.close();
});
