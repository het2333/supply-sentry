import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ConnectorRegistry, CredentialVault, LocalProcessConnectorAdapter, type ConnectorDescriptor } from '../src/index.js';

const descriptor: ConnectorDescriptor = {
  id: 'test', version: 1, name: 'Test', description: 'Test connector', icon: 'plug', vendor: 'Readywork', runtime: 'builtin', credentials: [],
  actions: [{ id: 'echo', name: 'Echo', description: 'Echo input', inputs: [], outputs: [], parameters: [], sideEffects: [], idempotent: true, risk: 'read' }],
};

test('ConnectorRegistry validates, executes and reports health', async () => {
  const registry = new ConnectorRegistry();
  registry.register(descriptor, {
    execute: async (_action, input) => ({ ok: true, output: input }),
    health: async () => ({ ok: true, message: 'ok' }),
  });
  const result = await registry.execute('test', 1, 'echo', { value: 42 }, { tenantId: 't', employeeId: 'e', runId: 'r', nodeRunId: 'n', idempotencyKey: 'k', credentials: {}, timeoutMs: 1000 });
  assert.deepEqual(result.output, { value: 42 });
  assert.deepEqual(await registry.health('test', 1), { ok: true, message: 'ok' });
});

test('CredentialVault encrypts credentials with authenticated encryption', () => {
  const vault = new CredentialVault('readywork-test-secret-that-is-long-enough');
  const encrypted = vault.encrypt({ username: 'buyer', password: 'secret' });
  assert.equal(encrypted.algorithm, 'aes-256-gcm');
  assert.equal(encrypted.ciphertext.includes('secret'), false);
  assert.deepEqual(vault.decrypt(encrypted), { username: 'buyer', password: 'secret' });
});

test('LocalProcessConnectorAdapter supervises and reuses one plugin process', async () => {
  const adapter = new LocalProcessConnectorAdapter({
    id: 'persistent-test', version: '1', protocolVersion: 1, command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/persistent-plugin.mjs', import.meta.url))], maxConcurrency: 2, timeoutMs: 2000,
  });
  const context = { tenantId: 't', employeeId: 'e', runId: 'r', nodeRunId: 'n', idempotencyKey: 'k', credentials: {}, timeoutMs: 2000 };
  const first = await adapter.execute('echo', { value: 1 }, context);
  const second = await adapter.execute('echo', { value: 2 }, context);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.output?.['pid'], second.output?.['pid']);
  assert.equal(second.output?.['calls'], 2);
  await adapter.close();
});
