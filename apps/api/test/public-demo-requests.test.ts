import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runMigrations } from '@readywork/persistence';
import { HttpError } from '../src/http-errors.js';
import { submitPublicDemoRequest } from '../src/public-demo-requests.js';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

const validRequest = {
  fullName: 'Jane Doe',
  email: 'JANE@ACME.COM',
  company: 'Acme Ltd',
  role: 'Head of Procurement',
  country: 'United Arab Emirates',
  erp: 'sap',
  poVolume: '100-500',
  message: 'Pilot a selected group of import purchase orders.',
};

test('公开 Demo 申请：真实落库并追加审计，规范化工作邮箱', () => {
  const db = database();
  const result = submitPublicDemoRequest(db, validRequest, 'demo-request:0001', { now: '2026-08-31T01:00:00.000Z' });
  assert.equal(result.accepted, true);
  assert.equal(result.replayed, false);
  const row = db.prepare('SELECT work_email,status,erp,po_volume FROM public_demo_requests WHERE id=?').get(result.requestId) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { work_email: 'jane@acme.com', status: 'submitted', erp: 'sap', po_volume: '100-500' });
  const events = db.prepare('SELECT event_type,actor_type FROM public_demo_request_events WHERE request_id=? ORDER BY seq').all(result.requestId);
  assert.deepEqual(events.map((event) => ({ ...(event as Record<string, unknown>) })), [{ event_type: 'submitted', actor_type: 'public_visitor' }]);
  db.close();
});

test('公开 Demo 申请：相同幂等键与载荷重放，不重复创建申请', () => {
  const db = database();
  const first = submitPublicDemoRequest(db, validRequest, 'demo-request:0002', { now: '2026-08-31T01:00:00.000Z' });
  const replay = submitPublicDemoRequest(db, validRequest, 'demo-request:0002', { now: '2026-08-31T01:01:00.000Z' });
  assert.equal(replay.replayed, true);
  assert.equal(replay.requestId, first.requestId);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM public_demo_requests').get() as { count: number }).count, 1);
  assert.deepEqual(
    (db.prepare('SELECT event_type FROM public_demo_request_events ORDER BY seq').all() as Array<{ event_type: string }>).map((row) => row.event_type),
    ['submitted', 'idempotent_replay'],
  );
  db.close();
});

test('公开 Demo 申请：同一幂等键不同载荷冲突且不污染审计', () => {
  const db = database();
  submitPublicDemoRequest(db, validRequest, 'demo-request:0003');
  assert.throws(
    () => submitPublicDemoRequest(db, { ...validRequest, company: 'Other Co' }, 'demo-request:0003'),
    (error: unknown) => error instanceof HttpError && error.status === 409 && error.code === 'DEMO_REQUEST_IDEMPOTENCY_CONFLICT',
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM public_demo_request_events').get() as { count: number }).count, 1);
  db.close();
});

test('公开 Demo 申请：必填、枚举、蜜罐与长度均在写入前校验', () => {
  const db = database();
  for (const input of [
    { ...validRequest, email: 'not-an-email' },
    { ...validRequest, erp: 'oracle' },
    { ...validRequest, website: 'https://spam.example' },
    { ...validRequest, message: 'x'.repeat(2_001) },
  ]) {
    assert.throws(() => submitPublicDemoRequest(db, input, `demo-invalid:${Math.random().toString(36).slice(2)}`), HttpError);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM public_demo_requests').get() as { count: number }).count, 0);
  db.close();
});
