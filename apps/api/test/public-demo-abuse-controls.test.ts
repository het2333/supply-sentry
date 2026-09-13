import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openPersistence } from '@readywork/persistence';
import {
  PublicDemoGenerationConflictError,
  PublicDemoRateLimiter,
  classifyPublicDemoRequest,
  publicDemoRequestBodyLimit,
  requireCurrentDemoGeneration,
} from '../src/public-demo-abuse-controls.js';
import { resetPublicDemo } from '../src/public-demo-reset.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return port;
}

function requestWithGeneration(generation: number | undefined): IncomingMessage {
  return {
    headers: generation === undefined ? {} : { 'x-readywork-demo-generation': String(generation) },
  } as IncomingMessage;
}

test('classifies entry, mutation, search, chat, and reset-sensitive read independently', () => {
  assert.equal(classifyPublicDemoRequest('POST', '/api/auth/public-demo'), 'entry');
  assert.equal(classifyPublicDemoRequest('POST', '/api/procurement/notifications/read-all'), 'mutation');
  assert.equal(classifyPublicDemoRequest('GET', '/api/procurement/search'), 'search');
  assert.equal(classifyPublicDemoRequest('POST', '/api/procurement/route-chat'), 'chat');
  assert.equal(classifyPublicDemoRequest('GET', '/api/procurement/workbench'), 'read');
  assert.equal(classifyPublicDemoRequest('GET', '/health'), null);
  assert.equal(classifyPublicDemoRequest('POST', '/internal/demo/reset'), null);
});

test('caps JSON at 1 MB, keeps the smaller route-chat cap, and disables multipart uploads', () => {
  assert.equal(publicDemoRequestBodyLimit('POST', '/api/procurement/notifications/read-all', 'application/json'), 1_048_576);
  assert.equal(publicDemoRequestBodyLimit('POST', '/api/procurement/route-chat', 'application/json; charset=utf-8'), 256 * 1024);
  assert.equal(publicDemoRequestBodyLimit('POST', '/api/po/chat', 'multipart/form-data; boundary=test'), 0);
  assert.equal(publicDemoRequestBodyLimit('GET', '/api/procurement/workbench', undefined), null);
});

test('enforces the approved per-minute limits and returns a retry delay', () => {
  let now = 1_800_000_000_000;
  const limiter = new PublicDemoRateLimiter({ now: () => now });
  const cases = [
    { method: 'POST', path: '/api/auth/public-demo', limit: 10 },
    { method: 'POST', path: '/api/procurement/notifications/read-all', limit: 120 },
    { method: 'GET', path: '/api/procurement/search', limit: 60 },
    { method: 'POST', path: '/api/procurement/route-chat', limit: 20 },
    { method: 'GET', path: '/api/procurement/workbench', limit: 120 },
  ] as const;

  for (const item of cases) {
    for (let index = 0; index < item.limit; index += 1) {
      assert.deepEqual(limiter.check({ ip: `192.0.2.${item.limit}`, username: 'public-demo', method: item.method, path: item.path }), { allowed: true });
    }
    assert.deepEqual(
      limiter.check({ ip: `192.0.2.${item.limit}`, username: 'public-demo', method: item.method, path: item.path }),
      { allowed: false, code: 'DEMO_RATE_LIMITED', retryAfterSeconds: 60 },
    );
  }

  now += 60_000;
  assert.deepEqual(limiter.check({ ip: '192.0.2.10', username: 'public-demo', method: 'POST', path: '/api/auth/public-demo' }), { allowed: true });
});

test('chat exhaustion does not consume the general mutation bucket', () => {
  const limiter = new PublicDemoRateLimiter({ now: () => 1_800_000_000_000 });
  for (let index = 0; index < 20; index += 1) {
    assert.equal(limiter.check({ ip: '198.51.100.8', username: 'public-demo', method: 'POST', path: '/api/po/chat' }).allowed, true);
  }
  assert.equal(limiter.check({ ip: '198.51.100.8', username: 'public-demo', method: 'POST', path: '/api/po/chat' }).allowed, false);
  assert.equal(limiter.check({ ip: '198.51.100.8', username: 'public-demo', method: 'POST', path: '/api/procurement/notifications/read-all' }).allowed, true);
});

test('stale and missing generations are rejected without changing SQLite', () => {
  const store = openPersistence(':memory:', { tenantId: 't:public-demo' });
  try {
    const first = resetPublicDemo(store.db, new Date('2026-09-13T04:00:00.000Z'));
    resetPublicDemo(store.db, new Date('2026-09-13T05:00:00.000Z'));
    const before = store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_notifications
      WHERE tenant_id='t:public-demo' AND status='unread'`).get() as { count: number };

    for (const supplied of [undefined, first.generation]) {
      assert.throws(
        () => requireCurrentDemoGeneration(requestWithGeneration(supplied), store.db),
        (error: unknown) => error instanceof PublicDemoGenerationConflictError
          && error.code === 'DEMO_GENERATION_CONFLICT'
          && error.currentGeneration === 2,
      );
    }

    const after = store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_notifications
      WHERE tenant_id='t:public-demo' AND status='unread'`).get() as { count: number };
    assert.deepEqual(after, before);
    assert.equal(requireCurrentDemoGeneration(requestWithGeneration(2), store.db), 2);
  } finally {
    store.close();
  }
});

test('HTTP boundary publishes generation, rejects stale writes and oversized JSON, and emits Retry-After', async () => {
  const port = await unusedPort();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'readywork-public-demo-abuse-'));
  const databasePath = join(temporaryDirectory, 'demo.sqlite');
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test', MEMORY: '0', DB_PATH: databasePath, PORT: String(port), READYWORK_API_HOST: '127.0.0.1', READYWORK_API_SURFACE: 'compat',
      READYWORK_PUBLIC_DEMO: '1', READYWORK_PUBLIC_DEMO_TENANT: 't:public-demo', READYWORK_PUBLIC_DEMO_SIMULATION_POLICY: 'simulated_demo',
      READYWORK_SESSION_SECRET: 'test-only-abuse-controls-session-secret',
      READYWORK_INTERNAL_CALLBACK_TOKEN: 'test-only-abuse-controls-internal-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let diagnostics = '';
  child.stdout.on('data', (chunk) => { diagnostics += String(chunk); });
  child.stderr.on('data', (chunk) => { diagnostics += String(chunk); });

  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* still starting */ }
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(child.exitCode, null, diagnostics);
    const reset = async () => fetch(`http://127.0.0.1:${port}/internal/demo/reset`, {
      method: 'POST', headers: { 'x-readywork-internal-token': 'test-only-abuse-controls-internal-token' },
    });
    assert.equal((await reset()).status, 200, diagnostics);

    const entry = await fetch(`http://127.0.0.1:${port}/api/auth/public-demo`, { method: 'POST' });
    assert.equal(entry.status, 200, diagnostics);
    const cookie = entry.headers.get('set-cookie')!.split(';')[0]!;
    const status = await fetch(`http://127.0.0.1:${port}/api/public-demo/status`, { headers: { cookie } });
    assert.equal(status.headers.get('x-readywork-demo-generation'), '1');

    assert.equal((await reset()).status, 200, diagnostics);
    const readUnreadCount = () => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return (db.prepare(`SELECT COUNT(*) AS count FROM procurement_notifications
          WHERE tenant_id='t:public-demo' AND status='unread'`).get() as { count: number }).count;
      } finally { db.close(); }
    };
    const unreadBefore = readUnreadCount();

    const stale = await fetch(`http://127.0.0.1:${port}/api/procurement/notifications/read-all`, {
      method: 'POST', headers: { cookie, 'x-readywork-demo-generation': '1' },
    });
    assert.equal(stale.status, 409, diagnostics);
    assert.equal(stale.headers.get('x-readywork-demo-generation'), '2');
    assert.deepEqual(await stale.json(), {
      error: '公开演示数据已重置，请刷新页面后重试',
      code: 'DEMO_GENERATION_CONFLICT',
      currentGeneration: 2,
    });
    assert.equal(readUnreadCount(), unreadBefore, 'stale mutation must not mark notifications as read');

    const missingLogoutGeneration = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(missingLogoutGeneration.status, 409, diagnostics);
    assert.equal((await missingLogoutGeneration.json() as { code: string }).code, 'DEMO_GENERATION_CONFLICT');

    const oversized = await fetch(`http://127.0.0.1:${port}/api/procurement/notifications/read-all`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-readywork-demo-generation': '2' },
      body: JSON.stringify({ padding: 'x'.repeat(1_048_576) }),
    });
    assert.equal(oversized.status, 413, diagnostics);
    assert.equal((await oversized.json() as { code: string }).code, 'BODY_TOO_LARGE');

    const uploadStatus = await new Promise<number>((done, reject) => {
      const upload = httpRequest({
        host: '127.0.0.1', port, method: 'POST',
        path: '/api/procurement/import-documents/pos/purchase-order%3Apublic-demo%3Anormal/documents',
        headers: { cookie, 'content-type': 'application/octet-stream', 'content-length': String(8 * 1024 * 1024) },
      }, (response) => {
        response.resume();
        response.once('end', () => { done(response.statusCode ?? 0); upload.destroy(); });
      });
      upload.once('error', reject);
      upload.write(Buffer.alloc(1));
    });
    assert.equal(uploadStatus, 403, 'upload must be denied without waiting for the declared body');

    for (let index = 0; index < 9; index += 1) {
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/public-demo`, { method: 'POST' })).status, 200);
    }
    const limited = await fetch(`http://127.0.0.1:${port}/api/auth/public-demo`, { method: 'POST' });
    assert.equal(limited.status, 429, diagnostics);
    assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/u);
    assert.equal((await limited.json() as { code: string }).code, 'DEMO_RATE_LIMITED');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise<void>((done) => child.exitCode !== null ? done() : child.once('exit', () => done()));
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
