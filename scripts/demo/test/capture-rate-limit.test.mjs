import assert from 'node:assert/strict';
import test from 'node:test';

test('capture retries a scene after the public-demo Retry-After window', async () => {
  const { withPublicDemoRateLimitRecovery } = await import('../capture-rate-limit.mjs');
  const retries = [900, 0];
  const attempts = [];
  const waits = [];

  const result = await withPublicDemoRateLimitRecovery({
    attempt: async (attempt) => {
      attempts.push(attempt);
      return retries.shift();
    },
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  assert.equal(result, 2);
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(waits, [1150]);
});

test('capture fails instead of publishing a scene that remains rate limited', async () => {
  const { withPublicDemoRateLimitRecovery } = await import('../capture-rate-limit.mjs');
  await assert.rejects(
    () => withPublicDemoRateLimitRecovery({
      attempt: async () => 100,
      wait: async () => {},
      maxAttempts: 2,
    }),
    /remained rate limited after 2 attempts/i,
  );
});

test('Retry-After parsing is fail-safe for public-demo responses', async () => {
  const { publicDemoRetryAfterMilliseconds } = await import('../capture-rate-limit.mjs');
  assert.equal(publicDemoRetryAfterMilliseconds(200, undefined), 0);
  assert.equal(publicDemoRetryAfterMilliseconds(429, '3'), 3000);
  assert.equal(publicDemoRetryAfterMilliseconds(429, '0.25'), 250);
  assert.equal(publicDemoRetryAfterMilliseconds(429, 'invalid'), 60_000);
});
