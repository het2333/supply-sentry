import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ProcurementV1ReadinessView } from '../src/procurement-v1-readiness.js';
import { createManufacturingContextRuntime } from '../src/manufacturing-context-worker.js';
import {
  persistedManufacturingContextReadiness,
  procurementV1ReadinessForOperations,
  recordManufacturingContextHeartbeat,
} from '../src/manufacturing-context-readiness.js';
import { surfaceAllows } from '../src/service-surface.js';
import { openPersistence } from '@readywork/persistence';

type ReadinessModule = {
  procurementV1ReadinessForOperations: (
    db: ReturnType<typeof openPersistence>['db'],
    tenantId: string,
    operations: Record<string, unknown>,
    now: Date,
  ) => ProcurementV1ReadinessView;
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

test('heartbeat publication rejects excessive future skew and a valid poll repairs a poisoned worker row', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:heartbeat-publication' });
  const now = new Date('2026-08-29T08:00:00.000Z');
  try {
    assert.throws(() => recordManufacturingContextHeartbeat(store.db, {
      tenantId: 'tenant:heartbeat-publication',
      workerId: 'context:future',
      workerReady: true,
      lastHeartbeatAt: '2026-08-29T08:00:05.001Z',
      pollIntervalMs: 3_000,
    }, now), /future|clock|skew|未来|时钟/i);

    store.db.prepare(`INSERT INTO twin_projection_worker_heartbeats
      (tenant_id,worker_id,worker_ready,last_heartbeat_at,poll_interval_ms,updated_at)
      VALUES (?,?,?,?,?,?)`).run(
      'tenant:heartbeat-publication', 'context:poisoned', 1,
      '2099-01-01T00:00:00.000Z', 3_000, '2099-01-01T00:00:00.000Z',
    );
    recordManufacturingContextHeartbeat(store.db, {
      tenantId: 'tenant:heartbeat-publication',
      workerId: 'context:poisoned',
      workerReady: true,
      lastHeartbeatAt: now.toISOString(),
      pollIntervalMs: 3_000,
    }, now);
    const repaired = store.db.prepare(`SELECT last_heartbeat_at,updated_at
      FROM twin_projection_worker_heartbeats WHERE tenant_id=? AND worker_id=?`).get(
      'tenant:heartbeat-publication', 'context:poisoned',
    ) as Record<string, unknown>;
    assert.deepEqual({ ...repaired }, {
      last_heartbeat_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
  } finally {
    store.close();
  }
});

test('actual control readiness selects the latest temporally valid worker and fails closed per tenant', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:valid-selection' });
  const now = new Date('2026-08-29T08:00:00.000Z');
  const insert = store.db.prepare(`INSERT INTO twin_projection_worker_heartbeats
    (tenant_id,worker_id,worker_ready,last_heartbeat_at,poll_interval_ms,updated_at)
    VALUES (?,?,?,?,?,?)`);
  try {
    insert.run('tenant:valid-selection', 'context:older', 1, '2026-08-29T07:59:58.000Z', 3_000, now.toISOString());
    insert.run('tenant:valid-selection', 'context:latest', 1, '2026-08-29T07:59:59.000Z', 3_000, now.toISOString());
    insert.run('tenant:valid-selection', 'context:future', 1, '2099-01-01T00:00:00.000Z', 3_000, now.toISOString());
    insert.run('tenant:valid-selection', 'context:invalid', 1, 'zzzz-not-an-instant', 3_000, now.toISOString());
    insert.run('tenant:isolated', 'context:not-ready', 0, now.toISOString(), 3_000, now.toISOString());
    insert.run('tenant:future-only', 'context:future', 1, '2099-01-01T00:00:00.000Z', 3_000, now.toISOString());
    insert.run('tenant:invalid-only', 'context:invalid', 1, 'not-an-instant', 3_000, now.toISOString());

    assert.deepEqual(persistedManufacturingContextReadiness(
      store.db, 'tenant:valid-selection', now,
    ), {
      workerReady: true,
      lastHeartbeatAt: '2026-08-29T07:59:59.000Z',
      pollIntervalMs: 3_000,
    });
    const selected = procurementV1ReadinessForOperations(store.db, 'tenant:valid-selection', {}, now);
    assert.equal(selected.gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'ready');
    assert.match(selected.gates.find((gate) => gate.id === 'manufacturing_context')?.detail ?? '', /2026-08-29T07:59:59\.000Z/);
    assert.equal(procurementV1ReadinessForOperations(
      store.db, 'tenant:isolated', {}, now,
    ).gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'blocked');
    for (const tenantId of ['tenant:future-only', 'tenant:invalid-only']) {
      assert.deepEqual(persistedManufacturingContextReadiness(store.db, tenantId, now), {
        workerReady: false,
        lastHeartbeatAt: null,
        pollIntervalMs: 3_000,
      });
      assert.equal(procurementV1ReadinessForOperations(
        store.db, tenantId, {}, now,
      ).gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'blocked');
    }
  } finally {
    store.close();
  }
});

test('split business worker publishes tenant heartbeat consumed by the control V1 readiness route', async () => {
  let readinessModule: ReadinessModule | undefined;
  try {
    readinessModule = await import('../src/manufacturing-context-readiness.js') as ReadinessModule;
  } catch {
    // RED: the production control/business readiness bridge does not exist yet.
  }
  assert.equal(typeof readinessModule?.procurementV1ReadinessForOperations, 'function');

  const directory = mkdtempSync(join(tmpdir(), 'readywork-context-readiness-'));
  const databasePath = join(directory, 'split.sqlite');
  const business = openPersistence(databasePath, { tenantId: 'tenant:a' });
  const control = openPersistence(databasePath, { tenantId: 'tenant:a' });
  try {
    const at = '2026-08-29T08:00:00.000Z';
    business.db.prepare(`INSERT INTO twin_projection_jobs
      (tenant_id,id,source_table,source_key,source_revision,event_type,payload_hash,status,attempts,max_attempts,
       available_at,projected_watermark,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,'succeeded',1,8,?,?,?,?,?)`).run(
      'tenant:a', 'job:already-complete', 'procurement_documents', 'po:none', '1',
      'purchase_order.backfill', 'hash', at, 'watermark', at, at, at,
    );
    business.db.prepare(`INSERT INTO twin_projection_jobs
      (tenant_id,id,source_table,source_key,source_revision,event_type,payload_hash,status,attempts,max_attempts,
       available_at,projected_watermark,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,'succeeded',1,8,?,?,?,?,?)`).run(
      'tenant:b', 'job:other-already-complete', 'procurement_documents', 'po:none', '1',
      'purchase_order.backfill', 'hash', at, 'watermark', at, at, at,
    );

    assert.equal(createManufacturingContextRuntime({
      surface: 'control', db: control.db, workerId: 'context:control', now: () => at,
    }), undefined, 'control surface must not create a second Context worker');
    const businessRuntime = createManufacturingContextRuntime({
      surface: 'business', db: business.db, workerId: 'context:business', now: () => at,
      pollIntervalMs: 3_000,
    });
    assert.ok(businessRuntime);
    assert.deepEqual(await businessRuntime.runOnce(), { 'tenant:a': 0, 'tenant:b': 0 },
      'successful empty polls must still publish liveness');

    business.db.prepare(`UPDATE twin_projection_worker_heartbeats
      SET last_heartbeat_at=?,updated_at=? WHERE tenant_id='tenant:b'`).run(
      '2026-08-29T07:59:00.000Z', '2026-08-29T07:59:00.000Z',
    );

    const sameTenant = readinessModule!.procurementV1ReadinessForOperations(
      control.db, 'tenant:a', {}, new Date(at),
    );
    const otherTenant = readinessModule!.procurementV1ReadinessForOperations(
      control.db, 'tenant:b', {}, new Date(at),
    );
    assert.equal(sameTenant.gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'ready');
    assert.equal(otherTenant.gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'blocked');

    const heartbeat = control.db.prepare(`SELECT tenant_id,worker_id,worker_ready,last_heartbeat_at,poll_interval_ms
      FROM twin_projection_worker_heartbeats WHERE tenant_id=?`).get('tenant:a') as Record<string, unknown> | undefined;
    assert.deepEqual({ ...heartbeat }, {
      tenant_id: 'tenant:a',
      worker_id: 'context:business:tenant:a',
      worker_ready: 1,
      last_heartbeat_at: at,
      poll_interval_ms: 3_000,
    });
    const otherHeartbeat = control.db.prepare(`SELECT tenant_id,worker_id,worker_ready,last_heartbeat_at,poll_interval_ms
      FROM twin_projection_worker_heartbeats WHERE tenant_id=?`).get('tenant:b') as Record<string, unknown> | undefined;
    assert.deepEqual({ ...otherHeartbeat }, {
      tenant_id: 'tenant:b',
      worker_id: 'context:business:tenant:b',
      worker_ready: 1,
      last_heartbeat_at: '2026-08-29T07:59:00.000Z',
      poll_interval_ms: 3_000,
    });
    assert.equal(surfaceAllows('business', 'GET', '/api/operations/v1-readiness'), false);
    assert.equal(surfaceAllows('control', 'GET', '/api/operations/v1-readiness'), true);
    assert.equal(surfaceAllows('control', 'GET', '/api/context/v1/projections/status'), false);
  } finally {
    control.close();
    business.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('actual control HTTP route consumes the persisted business heartbeat', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-context-http-readiness-'));
  const databasePath = join(directory, 'split.sqlite');
  const at = new Date().toISOString();
  const business = openPersistence(databasePath, { tenantId: 't:acme' });
  try {
    business.db.prepare(`INSERT INTO twin_projection_jobs
      (tenant_id,id,source_table,source_key,source_revision,event_type,payload_hash,status,attempts,max_attempts,
       available_at,projected_watermark,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,'succeeded',1,8,?,?,?,?,?)`).run(
      't:acme', 'job:http-already-complete', 'procurement_documents', 'po:none', '1',
      'purchase_order.backfill', 'hash', at, 'watermark', at, at, at,
    );
    const runtime = createManufacturingContextRuntime({
      surface: 'business', db: business.db, workerId: 'context:http-business', now: () => at,
      pollIntervalMs: 60_000,
    });
    assert.ok(runtime);
    assert.deepEqual(await runtime.runOnce(), { 't:acme': 0 });
  } finally {
    business.close();
  }

  const port = await unusedPort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DB_PATH: databasePath,
      PORT: String(port),
      READYWORK_API_HOST: '127.0.0.1',
      READYWORK_API_SURFACE: 'control',
      READYWORK_DEMO_AUTH: '1',
      READYWORK_CREDENTIAL_KEY: 'test-only-readiness-key-material',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', (chunk) => { diagnostics += String(chunk); });
  child.stderr.on('data', (chunk) => { diagnostics += String(chunk); });
  try {
    let health: Response | undefined;
    const healthDeadline = Date.now() + 60_000;
    while (Date.now() < healthDeadline) {
      if (child.exitCode !== null) break;
      try {
        health = await fetch(`http://127.0.0.1:${port}/health`);
        if (health.status === 200) break;
      } catch {
        // The child is still binding its loopback listener.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    assert.ok(health, `control API did not become ready:\n${diagnostics}`);
    assert.equal(health.status, 200, diagnostics);
    async function loginCookie(username: string, password: string): Promise<string> {
      const loginResponse = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(loginResponse.status, 200, diagnostics);
      const setCookie = loginResponse.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /^readywork_session=rw1\./);
      assert.match(setCookie, /; HttpOnly; SameSite=Lax;/);
      return setCookie.split(';')[0]!;
    }

    const cookie = await loginCookie('admin', 'admin123');
    const response = await fetch(`http://127.0.0.1:${port}/api/operations/v1-readiness`, { headers: { cookie } });
    assert.equal(response.status, 200, diagnostics);
    const body = await response.json() as ProcurementV1ReadinessView;
    assert.equal(body.totalGates, 11, 'messaging gateway rollout must not add a release gate');
    assert.deepEqual(body.gates.map((gate) => gate.id), [
      'communication_identity', 'published_sla', 'outbound_email', 'inbound_email', 'odoo',
      'document_security', 'durable_runtime', 'manufacturing_context', 'security_events',
      'local_purchase_order', 'five_stage_closed_loop',
    ]);
    assert.equal(body.gates.find((gate) => gate.id === 'five_stage_closed_loop')?.status, 'blocked',
      'a healthy runtime is not real route and Odoo/WMS GRN evidence');
    assert.equal(body.gates.find((gate) => gate.id === 'manufacturing_context')?.status, 'ready', diagnostics);

    const managerCookie = await loginCookie('manager', 'manager123');
    const managerSummary = await fetch(`http://127.0.0.1:${port}/api/operations/v1-readiness`, { headers: { cookie: managerCookie } });
    assert.equal(managerSummary.status, 200, '采购经理必须能读取脱敏、租户级 V1 发布摘要');
    assert.equal((await managerSummary.json() as ProcurementV1ReadinessView).totalGates, body.totalGates);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/operations/readiness`, { headers: { cookie: managerCookie } })).status, 403,
      '详细运行队列、连接器和文档运维数据仍只对管理员开放');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/operations/security-incidents`, { headers: { cookie: managerCookie } })).status, 403,
      '安全事故证据和处置控制面仍只对管理员开放');

    const buyerCookie = await loginCookie('buyer', 'buyer123');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/operations/v1-readiness`, { headers: { cookie: buyerCookie } })).status, 403,
      '不具备 configure 权限的采购专员不能读取发布治理摘要');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once('exit', () => resolveExit());
    });
    rmSync(directory, { recursive: true, force: true });
  }
});
