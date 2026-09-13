import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

test('public demo HTTP entry creates only the fixed limited session', async () => {
  const port = await unusedPort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MEMORY: '1',
      PORT: String(port),
      READYWORK_API_HOST: '127.0.0.1',
      READYWORK_API_SURFACE: 'compat',
      READYWORK_PUBLIC_DEMO: '1',
      READYWORK_PUBLIC_DEMO_TENANT: 't:public-demo',
      READYWORK_PUBLIC_DEMO_SIMULATION_POLICY: 'simulated_demo',
      READYWORK_SESSION_SECRET: 'test-only-public-demo-session-secret',
      READYWORK_INTERNAL_CALLBACK_TOKEN: 'test-only-public-demo-internal-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', (chunk) => { diagnostics += String(chunk); });
  child.stderr.on('data', (chunk) => { diagnostics += String(chunk); });

  try {
    let health: Response | undefined;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        health = await fetch(`http://127.0.0.1:${port}/health`);
        if (health.status === 200) break;
      } catch {
        // Child is still binding its listener.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    assert.ok(health, `public demo API did not become ready:\n${diagnostics}`);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: 'readywork-compat-api',
      surface: 'compat',
      version: '0.2.0',
      demoMode: true,
    });

    const config = await fetch(`http://127.0.0.1:${port}/api/auth/config`);
    assert.equal(config.status, 200, diagnostics);
    assert.deepEqual(await config.json(), {
      mode: 'public_demo',
      passwordLogin: false,
      demoMode: true,
    });

    const passwordLogin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'manager', password: 'manager123' }),
    });
    assert.equal(passwordLogin.status, 503, 'public demo must not expose the built-in password accounts');

    const entry = await fetch(`http://127.0.0.1:${port}/api/auth/public-demo`, { method: 'POST' });
    assert.equal(entry.status, 200, diagnostics);
    const cookie = entry.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^readywork_session=rw1\./);
    assert.match(cookie, /; HttpOnly; SameSite=Lax;/);
    assert.doesNotMatch(cookie, /; Secure(?:;|$)/, 'the approved HTTP demo address must receive a usable cookie');
    const entryBody = await entry.json() as Record<string, unknown>;
    assert.equal(entryBody['demoMode'], true);

    const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`, {
      headers: { cookie: cookie.split(';')[0]! },
    });
    assert.equal(me.status, 200, diagnostics);
    assert.deepEqual((await me.json() as { account: unknown; demoMode: boolean }).account, {
      username: 'public-demo',
      name: '公开演示采购经理',
      role: '采购经理',
      humanId: 'h:public-demo-manager',
    });

    const unauthorizedReset = await fetch(`http://127.0.0.1:${port}/internal/demo/reset`, { method: 'POST' });
    assert.equal(unauthorizedReset.status, 401);
    assert.equal((await unauthorizedReset.json() as { code: string }).code, 'UNAUTHORIZED');

    const reset = await fetch(`http://127.0.0.1:${port}/internal/demo/reset`, {
      method: 'POST',
      headers: { 'x-readywork-internal-token': 'test-only-public-demo-internal-token' },
    });
    assert.equal(reset.status, 200, diagnostics);
    const resetBody = await reset.json() as { generation: number; resetAt: string };
    assert.equal(resetBody.generation, 1);

    const status = await fetch(`http://127.0.0.1:${port}/api/public-demo/status`, {
      headers: { cookie: cookie.split(';')[0]! },
    });
    assert.equal(status.status, 200, diagnostics);
    assert.deepEqual(await status.json(), {
      demoMode: true,
      tenantId: 't:public-demo',
      seedVersion: 'public-demo-v1',
      generation: 1,
      resetAt: resetBody.resetAt,
      status: 'healthy',
    });

    const notifications = await fetch(`http://127.0.0.1:${port}/api/procurement/notifications?filter=all`, {
      headers: { cookie: cookie.split(';')[0]! },
    });
    assert.equal(notifications.status, 200, 'tenant-neutral procurement routes must not inherit the default tenant employee');
    assert.ok(Array.isArray((await notifications.json() as { items: unknown[] }).items));

    const simulatedAction = await fetch(`http://127.0.0.1:${port}/api/public-demo/simulated-actions`, {
      method: 'POST',
      headers: {
        cookie: cookie.split(';')[0]!,
        'content-type': 'application/json',
        'x-readywork-demo-generation': '1',
      },
      body: JSON.stringify({ scenarioId: 'purchase-order:public-demo:awaiting-confirmation' }),
    });
    assert.equal(simulatedAction.status, 200, diagnostics);
    const simulatedActionBody = await simulatedAction.json() as {
      ok: boolean;
      connector: string;
      action: string;
      output: { receiptKind: string; outcome: string; externalDelivery: boolean; generation: number };
    };
    assert.deepEqual({
      ok: simulatedActionBody.ok,
      connector: simulatedActionBody.connector,
      action: simulatedActionBody.action,
      receiptKind: simulatedActionBody.output.receiptKind,
      outcome: simulatedActionBody.output.outcome,
      externalDelivery: simulatedActionBody.output.externalDelivery,
      generation: simulatedActionBody.output.generation,
    }, {
      ok: true,
      connector: 'email',
      action: 'send',
      receiptKind: 'simulated_demo',
      outcome: 'accepted',
      externalDelivery: false,
      generation: 1,
    });

    const denied = await fetch(`http://127.0.0.1:${port}/api/editor/workflows`, {
      headers: { cookie: cookie.split(';')[0]! },
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), {
      error: '公开演示环境已禁用此功能',
      code: 'PUBLIC_DEMO_CAPABILITY_DISABLED',
    });
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise<void>((resolveExit) => {
      if (child.exitCode !== null) resolveExit();
      else child.once('exit', () => resolveExit());
    });
  }
});
