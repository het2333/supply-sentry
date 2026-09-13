const RETRY_BUFFER_MS = 250;
const DEFAULT_RETRY_AFTER_MS = 60_000;

export function publicDemoRetryAfterMilliseconds(status, retryAfterHeader) {
  if (status !== 429) return 0;
  const seconds = Number(retryAfterHeader);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds * 1000)
    : DEFAULT_RETRY_AFTER_MS;
}

export async function withPublicDemoRateLimitRecovery({ attempt, wait, maxAttempts = 3 }) {
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
    const retryAfterMilliseconds = await attempt(attemptNumber);
    if (!retryAfterMilliseconds) return attemptNumber;
    if (attemptNumber === maxAttempts) {
      throw new Error(`Public-demo scene remained rate limited after ${maxAttempts} attempts`);
    }
    await wait(retryAfterMilliseconds + RETRY_BUFFER_MS);
  }
  throw new Error('Public-demo capture retry state is invalid');
}
