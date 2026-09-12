import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TwinProjectionPayloadConflictError } from '@readywork/core';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import { projectionRetryAt, SqliteTwinProjectionQueue } from '../src/index.js';

const at = '2026-08-21T00:00:00.000Z';

function createDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  return db;
}

function enqueueInput(overrides: Partial<{
  sourceTable: string;
  sourceKey: string;
  sourceRevision: string;
  eventType: string;
  payloadHash: string;
  availableAt: string;
}> = {}) {
  return {
    sourceTable: 'procurement_documents',
    sourceKey: 'purchase_order:po:1',
    sourceRevision: '1',
    eventType: 'purchase_order.changed',
    payloadHash: 'hash:1',
    availableAt: at,
    ...overrides,
  };
}

test('projection retry times use the exact seven-delay schedule before the eighth attempt dead-letters', () => {
  const expected = [
    '2026-08-21T00:00:05.000Z',
    '2026-08-21T00:00:30.000Z',
    '2026-08-21T00:02:00.000Z',
    '2026-08-21T00:10:00.000Z',
    '2026-08-21T00:30:00.000Z',
    '2026-08-21T01:00:00.000Z',
    '2026-08-21T04:00:00.000Z',
  ];
  assert.deepEqual(expected.map((_, index) => projectionRetryAt(at, index + 1)), expected);
  assert.equal(projectionRetryAt(at, 8), undefined);
});

test('enqueue is tenant-scoped and returns the existing job only for an identical source payload hash', () => {
  const db = createDb();
  const tenantA = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const first = tenantA.enqueue(enqueueInput());
  const replayed = tenantA.enqueue(enqueueInput());

  assert.equal(first.tenantId, 'tenant:a');
  assert.equal(first.payloadHash, 'hash:1');
  assert.equal(replayed.id, first.id);
  assert.equal(replayed.payloadHash, 'hash:1');
  assert.equal(tenantA.get(first.id)?.tenantId, 'tenant:a');
  assert.equal(new SqliteTwinProjectionQueue(db, 'tenant:b').get(first.id), undefined);
  assert.deepEqual(tenantA.status(), {
    queued: 1, processing: 0, retryWait: 0, succeeded: 0, deadLetter: 0,
  });
  db.close();
});

test('enqueue joins an outer transaction and its job is removed by the outer rollback', () => {
  const db = createDb();
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  db.exec('BEGIN IMMEDIATE');
  const job = queue.enqueue(enqueueInput());
  assert.equal(db.isTransaction, true);
  assert.equal(queue.get(job.id)?.id, job.id);
  db.exec('ROLLBACK');
  assert.equal(queue.get(job.id), undefined);
  db.close();
});

test('queue mutations join an outer transaction without committing or rolling it back', () => {
  const db = createDb();
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  db.exec('BEGIN IMMEDIATE');

  const succeededJob = queue.enqueue(enqueueInput({ sourceKey: 'purchase_order:po:success' }));
  const succeededClaim = queue.claim({ workerId: 'worker:success', claimedAt: at, leaseDurationMs: 1_000, limit: 1 })[0]!;
  queue.succeed({ id: succeededJob.id, leaseToken: succeededClaim.leaseToken!, completedAt: at, projectedWatermark: 'w:1' });
  assert.equal(db.isTransaction, true);

  const failedJob = queue.enqueue(enqueueInput({ sourceKey: 'purchase_order:po:fail' }));
  const failedClaim = queue.claim({ workerId: 'worker:fail', claimedAt: at, leaseDurationMs: 1_000, limit: 1 })[0]!;
  queue.fail({ id: failedJob.id, leaseToken: failedClaim.leaseToken!, failedAt: at, error: 'safe failure' });
  assert.equal(db.isTransaction, true);

  db.prepare(`UPDATE twin_projection_jobs SET status='dead_letter'
    WHERE tenant_id=? AND id=?`).run('tenant:a', failedJob.id);
  queue.replayDeadLetter({ id: failedJob.id, actorId: 'human:admin', replayedAt: at });
  assert.equal(db.isTransaction, true);

  db.exec('ROLLBACK');
  assert.equal(queue.get(succeededJob.id), undefined);
  assert.equal(queue.get(failedJob.id), undefined);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM runtime_activities
    WHERE tenant_id=?`).get('tenant:a')?.['count'], 0);
  db.close();
});

test('enqueue audits a hash conflict without persisting source payload and throws the domain conflict', () => {
  const db = createDb();
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const first = queue.enqueue(enqueueInput());

  assert.throws(
    () => queue.enqueue(enqueueInput({ payloadHash: 'hash:conflict' })),
    (error: unknown) => error instanceof TwinProjectionPayloadConflictError
      && error.sourceKey === 'purchase_order:po:1',
  );
  const event = db.prepare(`SELECT tenant_id,event_type,message FROM control_security_events
    WHERE tenant_id=?`).get('tenant:a') as { tenant_id: string; event_type: string; message: string };
  const message = JSON.parse(event.message) as Record<string, unknown>;
  assert.deepEqual({ ...event }, {
    tenant_id: 'tenant:a',
    event_type: 'twin_projection_payload_conflict',
    message: event.message,
  });
  assert.deepEqual(message, {
    jobId: first.id,
    sourceTable: 'procurement_documents',
    sourceKey: 'purchase_order:po:1',
    sourceRevision: '1',
    eventType: 'purchase_order.changed',
    existingPayloadHash: 'hash:1',
    incomingPayloadHash: 'hash:conflict',
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM twin_projection_jobs
    WHERE tenant_id=?`).get('tenant:a')?.['count'], 1);
  assert.doesNotMatch(event.message, /must-not-be-stored/);
  db.close();
});

test('claim hides an active lease from other workers and reclaims it after expiry with a new token', () => {
  const db = createDb();
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const job = queue.enqueue(enqueueInput());
  const first = queue.claim({ workerId: 'worker:1', claimedAt: at, leaseDurationMs: 1_000, limit: 1 })[0]!;

  assert.equal(first.id, job.id);
  assert.equal(first.attempts, 1);
  assert.equal(first.leaseOwner, 'worker:1');
  assert.deepEqual(queue.claim({
    workerId: 'worker:2', claimedAt: '2026-08-21T00:00:00.999Z', leaseDurationMs: 1_000, limit: 1,
  }), []);
  const reclaimed = queue.claim({
    workerId: 'worker:2', claimedAt: '2026-08-21T00:00:01.000Z', leaseDurationMs: 1_000, limit: 1,
  })[0]!;
  assert.equal(reclaimed.attempts, 2);
  assert.equal(reclaimed.leaseOwner, 'worker:2');
  assert.notEqual(reclaimed.leaseToken, first.leaseToken);
  assert.throws(() => queue.succeed({
    id: job.id,
    leaseToken: first.leaseToken!,
    completedAt: '2026-08-21T00:00:01.500Z',
    projectedWatermark: 'watermark:stale',
  }));
  assert.equal(queue.get(job.id)?.leaseToken, reclaimed.leaseToken);
  db.close();
});

test('expired lease reclamation claims attempt 8 but atomically dead-letters a row already capped at 8', () => {
  const db = createDb();
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const concurrent = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const otherTenant = new SqliteTwinProjectionQueue(db, 'tenant:b');
  const attempt7 = queue.enqueue(enqueueInput({ sourceKey: 'purchase_order:po:attempt-7' }));
  const attempt8 = queue.enqueue(enqueueInput({ sourceKey: 'purchase_order:po:attempt-8' }));
  const foreign = otherTenant.enqueue(enqueueInput({ sourceKey: 'purchase_order:po:foreign-attempt-8' }));
  for (const [tenantId, id, attempts] of [
    ['tenant:a', attempt7.id, 7], ['tenant:a', attempt8.id, 8], ['tenant:b', foreign.id, 8],
  ] as const) {
    db.prepare(`UPDATE twin_projection_jobs SET status='processing',attempts=?,lease_owner='old-worker',
      lease_token='old-token',lease_expires_at='2026-08-20T23:59:59.000Z' WHERE tenant_id=? AND id=?`)
      .run(attempts, tenantId, id);
  }

  const claimed = queue.claim({ workerId: 'worker:new', claimedAt: at, leaseDurationMs: 1_000, limit: 10 });
  assert.deepEqual(claimed.map((job) => job.id), [attempt7.id]);
  assert.equal(claimed[0]!.attempts, 8);
  assert.deepEqual(concurrent.claim({ workerId: 'worker:concurrent', claimedAt: at, leaseDurationMs: 1_000, limit: 10 }), []);
  const capped = queue.get(attempt8.id)!;
  assert.equal(capped.status, 'dead_letter');
  assert.equal(capped.attempts, 8);
  assert.equal(capped.leaseOwner, undefined);
  assert.equal(capped.leaseToken, undefined);
  assert.equal(capped.leaseExpiresAt, undefined);
  assert.equal(capped.completedAt, at);
  assert.match(capped.lastError ?? '', /expired|max.*attempt|租约|上限/i);
  assert.equal(otherTenant.get(foreign.id)?.status, 'processing');
  assert.equal(otherTenant.get(foreign.id)?.attempts, 8);

  const replayed = queue.replayDeadLetter({ id: attempt8.id, actorId: 'human:admin', replayedAt: at });
  assert.equal(replayed.status, 'queued');
  assert.equal(replayed.attempts, 0);
  assert.equal(replayed.lastError, capped.lastError);
  const replayClaim = queue.claim({ workerId: 'worker:replay', claimedAt: at, leaseDurationMs: 1_000, limit: 1 })[0]!;
  assert.equal(replayClaim.id, attempt8.id);
  assert.equal(replayClaim.attempts, 1);
  const audit = JSON.parse(String(db.prepare(`SELECT json FROM runtime_activities
    WHERE tenant_id='tenant:a' AND object_id=?`).get(attempt8.id)?.['json'])) as Record<string, any>;
  assert.equal(audit.context.previousAttempts, 8);
  db.close();
});

test('enqueue and claim normalize offset timestamps and compare their actual instants', () => {
  const db = createDb();
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const job = queue.enqueue(enqueueInput({
    sourceKey: 'purchase_order:po:offset-claim',
    availableAt: '2026-08-21T08:30:00+08:00',
  }));

  assert.equal(job.availableAt, '2026-08-21T00:30:00.000Z');
  assert.deepEqual(queue.claim({
    workerId: 'worker:offset',
    claimedAt: '2026-08-20T19:29:59-05:00',
    leaseDurationMs: 60_000,
    limit: 1,
  }), []);
  const claimed = queue.claim({
    workerId: 'worker:offset',
    claimedAt: '2026-08-20T19:30:00-05:00',
    leaseDurationMs: 60_000,
    limit: 1,
  })[0]!;
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.updatedAt, '2026-08-21T00:30:00.000Z');
  assert.equal(claimed.leaseExpiresAt, '2026-08-21T00:31:00.000Z');
  db.close();
});

test('succeed, fail, and replay persist offset event times in canonical UTC', () => {
  const db = createDb();
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');

  const succeededJob = queue.enqueue(enqueueInput({ sourceKey: 'purchase_order:po:offset-success' }));
  const succeededLease = queue.claim({ workerId: 'worker:success', claimedAt: at, leaseDurationMs: 3_600_000, limit: 1 })[0]!;
  const succeeded = queue.succeed({
    id: succeededJob.id,
    leaseToken: succeededLease.leaseToken!,
    completedAt: '2026-08-21T08:30:00+08:00',
    projectedWatermark: 'watermark:offset',
  });
  assert.equal(succeeded.completedAt, '2026-08-21T00:30:00.000Z');
  assert.equal(succeeded.updatedAt, '2026-08-21T00:30:00.000Z');

  const failedJob = queue.enqueue(enqueueInput({ sourceKey: 'purchase_order:po:offset-fail' }));
  const failedLease = queue.claim({ workerId: 'worker:fail', claimedAt: at, leaseDurationMs: 3_600_000, limit: 1 })[0]!;
  const failed = queue.fail({
    id: failedJob.id,
    leaseToken: failedLease.leaseToken!,
    failedAt: '2026-08-21T08:30:00+08:00',
    error: 'safe failure',
  });
  assert.equal(failed.updatedAt, '2026-08-21T00:30:00.000Z');
  assert.equal(failed.availableAt, '2026-08-21T00:30:05.000Z');

  db.prepare(`UPDATE twin_projection_jobs SET status='dead_letter'
    WHERE tenant_id=? AND id=?`).run('tenant:a', failedJob.id);
  const replayed = queue.replayDeadLetter({
    id: failedJob.id,
    actorId: 'human:admin',
    replayedAt: '2026-08-21T08:45:00+08:00',
  });
  assert.equal(replayed.availableAt, '2026-08-21T00:45:00.000Z');
  assert.equal(replayed.updatedAt, '2026-08-21T00:45:00.000Z');
  const activity = JSON.parse(String(db.prepare(`SELECT json FROM runtime_activities
    WHERE tenant_id=? AND object_id=?`).get('tenant:a', failedJob.id)?.['json'])) as { at: string };
  assert.equal(activity.at, '2026-08-21T00:45:00.000Z');
  db.close();
});

test('only the current tenant lease holder can succeed a processing job', () => {
  const db = createDb();
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const otherTenant = new SqliteTwinProjectionQueue(db, 'tenant:b');
  const job = queue.enqueue(enqueueInput());
  const claimed = queue.claim({ workerId: 'worker:1', claimedAt: at, leaseDurationMs: 10_000, limit: 1 })[0]!;

  assert.throws(() => otherTenant.succeed({
    id: job.id, leaseToken: claimed.leaseToken!, completedAt: at, projectedWatermark: 'watermark:wrong-tenant',
  }));
  assert.throws(() => queue.succeed({
    id: job.id, leaseToken: 'lease:wrong', completedAt: at, projectedWatermark: 'watermark:wrong-token',
  }));
  const succeeded = queue.succeed({
    id: job.id, leaseToken: claimed.leaseToken!, completedAt: at, projectedWatermark: 'watermark:1',
  });
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.projectedWatermark, 'watermark:1');
  assert.equal(succeeded.completedAt, at);
  assert.equal(succeeded.leaseToken, undefined);
  db.close();
});

test('an old worker cannot succeed or fail at the exact lease expiry boundary while a new worker can reclaim', () => {
  const db = createDb();
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const expiry = '2026-08-21T00:00:01.000Z';

  const succeedJob = queue.enqueue(enqueueInput({ sourceKey: 'purchase_order:po:boundary-succeed' }));
  const succeedLease = queue.claim({ workerId: 'worker:old', claimedAt: at, leaseDurationMs: 1_000, limit: 1 })[0]!;
  assert.throws(() => queue.succeed({
    id: succeedJob.id,
    leaseToken: succeedLease.leaseToken!,
    completedAt: expiry,
    projectedWatermark: 'watermark:expired',
  }));
  const succeedReclaimed = queue.claim({ workerId: 'worker:new', claimedAt: expiry, leaseDurationMs: 1_000, limit: 1 })[0]!;
  assert.equal(succeedReclaimed.id, succeedJob.id);
  assert.notEqual(succeedReclaimed.leaseToken, succeedLease.leaseToken);
  queue.succeed({
    id: succeedJob.id,
    leaseToken: succeedReclaimed.leaseToken!,
    completedAt: expiry,
    projectedWatermark: 'watermark:new-owner',
  });

  const failJob = queue.enqueue(enqueueInput({ sourceKey: 'purchase_order:po:boundary-fail' }));
  const failLease = queue.claim({ workerId: 'worker:old', claimedAt: at, leaseDurationMs: 1_000, limit: 1 })[0]!;
  assert.throws(() => queue.fail({
    id: failJob.id,
    leaseToken: failLease.leaseToken!,
    failedAt: expiry,
    error: 'expired failure',
  }));
  const failReclaimed = queue.claim({ workerId: 'worker:new', claimedAt: expiry, leaseDurationMs: 1_000, limit: 1 })[0]!;
  assert.equal(failReclaimed.id, failJob.id);
  assert.notEqual(failReclaimed.leaseToken, failLease.leaseToken);
  db.close();
});

test('fail redacts secrets, follows every retry delay, and dead-letters the eighth failure', () => {
  const db = createDb();
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const environmentSecret = 'projection-environment-secret';
  const previousEnvironmentSecret = process.env['READYWORK_PROJECTION_API_TOKEN'];
  process.env['READYWORK_PROJECTION_API_TOKEN'] = environmentSecret;
  queue.enqueue(enqueueInput());
  let claimed = queue.claim({ workerId: 'worker:1', claimedAt: at, leaseDurationMs: 30_000, limit: 1 })[0]!;
  const expectedRetryAt = [
    '2026-08-21T00:00:05.000Z',
    '2026-08-21T00:00:35.000Z',
    '2026-08-21T00:02:35.000Z',
    '2026-08-21T00:12:35.000Z',
    '2026-08-21T00:42:35.000Z',
    '2026-08-21T01:42:35.000Z',
    '2026-08-21T05:42:35.000Z',
  ];

  try {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const failedAt = claimed.availableAt;
      const failed = queue.fail({
        id: claimed.id,
        leaseToken: claimed.leaseToken!,
        failedAt,
        error: [
          'Bearer bearer-secret', 'Authorization: Basic basic-secret',
          'Authorization=Bearer authorization-bearer-secret',
          '{"token":"json-secret"}', 'password="quoted-secret"',
          'https://alice:url-password@example.test/path', environmentSecret,
        ].join(' | '),
      });
      assert.doesNotMatch(
        failed.lastError ?? '',
        /bearer-secret|basic-secret|authorization-bearer-secret|json-secret|quoted-secret|url-password|projection-environment-secret/,
      );
      assert.match(failed.lastError ?? '', /\[REDACTED\]/);
      if (attempt === 8) {
        assert.equal(failed.status, 'dead_letter');
        assert.equal(failed.availableAt, expectedRetryAt[6]);
        break;
      }
      assert.equal(failed.status, 'retry_wait');
      assert.equal(failed.availableAt, expectedRetryAt[attempt - 1]);
      claimed = queue.claim({
        workerId: 'worker:1', claimedAt: failed.availableAt, leaseDurationMs: 30_000, limit: 1,
      })[0]!;
    }
  } finally {
    if (previousEnvironmentSecret === undefined) delete process.env['READYWORK_PROJECTION_API_TOKEN'];
    else process.env['READYWORK_PROJECTION_API_TOKEN'] = previousEnvironmentSecret;
  }
  assert.deepEqual(queue.status(), {
    queued: 0, processing: 0, retryWait: 0, succeeded: 0, deadLetter: 1,
  });
  db.close();
});

test('replay accepts only this tenant dead letter, preserves failure history, clears leases, and appends audit', () => {
  const db = createDb();
  const queue = new SqliteTwinProjectionQueue(db, 'tenant:a');
  const otherTenant = new SqliteTwinProjectionQueue(db, 'tenant:b');
  const job = queue.enqueue(enqueueInput());
  db.prepare(`UPDATE twin_projection_jobs
    SET status='dead_letter',attempts=8,last_error='safe failure',lease_owner='old',lease_token='old-token',lease_expires_at=?
    WHERE tenant_id=? AND id=?`).run(at, 'tenant:a', job.id);

  assert.throws(() => otherTenant.replayDeadLetter({ id: job.id, actorId: 'human:other', replayedAt: at }));
  const replayed = queue.replayDeadLetter({ id: job.id, actorId: 'human:admin', replayedAt: at });
  assert.equal(replayed.status, 'queued');
  assert.equal(replayed.attempts, 0);
  assert.equal(replayed.lastError, 'safe failure');
  assert.equal(replayed.availableAt, at);
  assert.equal(replayed.leaseOwner, undefined);
  assert.equal(replayed.leaseToken, undefined);
  assert.equal(replayed.leaseExpiresAt, undefined);
  const activityRow = db.prepare(`SELECT tenant_id,object_id,json FROM runtime_activities
    WHERE tenant_id=? AND object_id=?`).get('tenant:a', job.id) as {
      tenant_id: string; object_id: string; json: string;
    };
  const activity = JSON.parse(activityRow.json) as Record<string, unknown>;
  assert.equal(activityRow.tenant_id, 'tenant:a');
  assert.equal(activityRow.object_id, job.id);
  assert.equal(activity['actor'], 'human:admin');
  assert.equal(activity['action'], 'twin.projection_replayed');
  assert.equal(activity['at'], at);
  assert.equal(activity['objectId'], job.id);
  assert.equal((activity['context'] as Record<string, unknown>)['previousAttempts'], 8);
  const reclaimed = queue.claim({ workerId: 'worker:replay', claimedAt: at, leaseDurationMs: 1_000, limit: 1 })[0]!;
  assert.equal(reclaimed.id, job.id);
  assert.equal(reclaimed.attempts, 1);
  assert.throws(() => queue.replayDeadLetter({ id: job.id, actorId: 'human:admin', replayedAt: at }));
  db.close();
});
