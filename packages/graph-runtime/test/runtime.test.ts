import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeFactory, VariablePool, validateGraph, type NodeTypeDescriptor } from '../src/index.js';
import { PROCUREMENT_NODE_DESCRIPTORS } from '@readywork/supply-chain';

const descriptor: NodeTypeDescriptor = {
  type: 'test.echo', version: 1, name: 'Echo', description: 'Echo input', icon: 'message', category: 'logic',
  inputs: [{ id: 'value', label: 'Value', dataType: 'string', required: true }],
  outputs: [{ id: 'value', label: 'Value', dataType: 'string' }],
  parameters: [{ id: 'prefix', label: 'Prefix', control: 'text', required: true }], credentials: [], runtime: 'builtin', executor: 'test:echo',
};

test('NodeFactory registers versioned descriptors and executors', async () => {
  const factory = new NodeFactory();
  factory.register(descriptor, { execute: async (_node, input) => ({ status: 'completed', outputs: input }) });
  assert.equal(factory.describe('test.echo', 1)?.executor, 'test:echo');
  const result = await factory.create({ id: 'echo', type: 'test.echo', typeVersion: 1, name: 'Echo', config: { prefix: '>' } }).execute(
    { id: 'echo', type: 'test.echo', typeVersion: 1, name: 'Echo', config: { prefix: '>' } },
    { value: 'ok' },
    { tenantId: 't', employeeId: 'e', workflowId: 'w', workflowVersionId: 'v', runId: 'r', nodeRunId: 'nr', mode: 'simulate', variables: {}, credentials: {} },
  );
  assert.deepEqual(result.outputs, { value: 'ok' });
});

test('graph validation checks parameters, ports and cycles', () => {
  const factory = new NodeFactory();
  factory.register(descriptor, { execute: async () => ({ status: 'completed', outputs: {} }) });
  const issues = validateGraph({
    id: 'g', tenantId: 't', employeeId: 'e', name: 'Graph',
    nodes: [
      { id: 'a', type: 'test.echo', typeVersion: 1, name: 'A', config: {} },
      { id: 'b', type: 'test.echo', typeVersion: 1, name: 'B', config: { prefix: '>' } },
    ],
    edges: [
      { id: 'ab', source: 'a', sourcePort: 'value', target: 'b', targetPort: 'value' },
      { id: 'ba', source: 'b', sourcePort: 'value', target: 'a', targetPort: 'value' },
    ],
  }, factory);
  assert.ok(issues.some((issue) => issue.code === 'missing_parameter'));
  assert.ok(issues.some((issue) => issue.code === 'cycle'));
});

test('VariablePool resolves expressions and procurement email node follows the standard contract', () => {
  const pool = new VariablePool({ supplier: { id: 's:1' } });
  pool.set('mail.subject', '交期确认');
  assert.equal(pool.resolve('供应商 {{ supplier.id }}：{{ mail.subject }}'), '供应商 s:1：交期确认');
  const email = PROCUREMENT_NODE_DESCRIPTORS.find((item) => item.type === 'connector.email.send_supplier_email');
  assert.deepEqual(email?.inputs.map((port) => port.id), ['supplier_id', 'subject', 'body', 'attachments']);
  assert.deepEqual(email?.outputs.map((port) => port.id), ['message_id', 'sent_at']);
  assert.deepEqual(email?.credentials.map((credential) => credential.type), ['emailCredential']);
  assert.equal(email?.executor, 'connector:email.send');
});
