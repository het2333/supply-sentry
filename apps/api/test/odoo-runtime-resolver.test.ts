import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { ToolRegistry } from '@readywork/tools';
import { ConnectorControlPlane } from '../src/connector-control-plane.js';
import { OdooRuntimeResolver } from '../src/odoo-runtime-resolver.js';

const key = 'odoo-runtime-resolver-test-key-that-is-long-enough';

function connect(control: ConnectorControlPlane, db: ReturnType<typeof openPersistence>['db'], tenantId: string, id: string, testedAt: string): void {
  control.putCredential({
    id, connectorId: 'erp', credentialType: 'erpCredential', name: `${tenantId} ERP`,
    value: { baseUrl: `https://${tenantId}.example.test`, database: 'odoo', apiKey: `secret-${tenantId}` },
  });
  db.prepare("UPDATE control_credentials SET status='connected',last_tested_at=?,updated_at=? WHERE tenant_id=? AND id=?")
    .run(testedAt, testedAt, tenantId, id);
}

test('Odoo runtime resolver: tenant 隔离、轮换/删除自然失效、未验证/停用 fail closed 且重启可恢复', async () => {
  const previous = process.env['READYWORK_CREDENTIAL_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = key;
  const store = openPersistence(':memory:', { tenantId: 'tenant:a' });
  try {
    const a = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:a');
    const b = new ConnectorControlPlane(store.db, new ToolRegistry(), 'tenant:b');
    connect(a, store.db, 'tenant:a', 'credential:a:v1', '2026-09-01T00:00:00.000Z');
    b.putCredential({ id: 'credential:b:untested', connectorId: 'erp', credentialType: 'erpCredential', name: 'B ERP', value: { baseUrl: 'https://b.example.test', database: 'odoo', apiKey: 'secret-b' } });

    const resolver = new OdooRuntimeResolver(store.db, key);
    const first = resolver.resolve('tenant:a');
    assert.equal(first?.credential.credentialId, 'credential:a:v1');
    assert.equal(first?.credential.credentialVersion, '2026-09-01T00:00:00.000Z');
    assert.equal(resolver.resolve('tenant:b'), undefined, 'other tenant cannot use A and untested B is rejected');
    assert.equal(JSON.stringify(first?.credential).includes('secret-tenant:a'), false);
    assert.equal(JSON.stringify(first?.credential).includes('example.test'), false);

    // A stale error must win even if an older caller left status as connected.
    store.db.prepare("UPDATE control_credentials SET last_error=? WHERE tenant_id=? AND id=?")
      .run('Odoo authentication failed', 'tenant:a', 'credential:a:v1');
    assert.equal(resolver.resolve('tenant:a'), undefined, 'connected + tested with last_error must fail closed');
    store.db.prepare("UPDATE control_credentials SET last_error=NULL WHERE tenant_id=? AND id=?")
      .run('tenant:a', 'credential:a:v1');
    assert.equal(resolver.resolve('tenant:a')?.credential.credentialId, 'credential:a:v1', 'clearing the error restores an otherwise verified credential');

    // A credential save resets verification; a cached client must not survive it.
    a.putCredential({ id: 'credential:a:v1', connectorId: 'erp', credentialType: 'erpCredential', name: 'A ERP rotated', value: { baseUrl: 'https://rotated.example.test', database: 'odoo', apiKey: 'secret-rotated' } });
    assert.equal(resolver.resolve('tenant:a'), undefined, 'rotation becomes untested before another external verification');
    store.db.prepare("UPDATE control_credentials SET status='connected',last_tested_at=?,updated_at=? WHERE tenant_id=? AND id=?")
      .run('2026-09-02T00:00:00.000Z', '2026-09-02T00:00:00.000Z', 'tenant:a', 'credential:a:v1');
    const rotated = resolver.resolve('tenant:a');
    assert.equal(rotated?.credential.lastTestedAt, '2026-09-02T00:00:00.000Z');
    assert.notEqual(rotated, first, 'cache key includes the updated credential version/test time');

    const afterRestart = new OdooRuntimeResolver(store.db, key).resolve('tenant:a');
    assert.equal(afterRestart?.credential.credentialId, 'credential:a:v1', 'persisted verified credential resolves after process restart');
    await a.disable('erp');
    assert.equal(resolver.resolve('tenant:a'), undefined, 'disabled ERP connector cannot retain a cached client');
    await a.enable('erp');
    assert.equal(resolver.resolve('tenant:a')?.credential.credentialId, 'credential:a:v1');
    assert.equal(a.deleteCredential('credential:a:v1'), true);
    assert.equal(resolver.resolve('tenant:a'), undefined, 'deletion invalidates the cache via metadata lookup');
  } finally {
    store.close();
    if (previous === undefined) delete process.env['READYWORK_CREDENTIAL_KEY']; else process.env['READYWORK_CREDENTIAL_KEY'] = previous;
  }
});
