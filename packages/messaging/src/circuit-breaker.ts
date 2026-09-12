import type { AdapterFailure, MessagingAdapterState } from './contracts.js';

const FAILURE_WINDOW_MS = 5 * 60 * 1_000;
const BREAKER_THRESHOLD = 3;

export function isAdapterBlocked(state: MessagingAdapterState): boolean {
  return !['running', 'degraded'].includes(state.status);
}

export function recordAdapterSuccess(state: MessagingAdapterState, at: string, startedVersion = state.version): MessagingAdapterState {
  if (isAdapterBlocked(state) || state.version !== startedVersion) {
    return { ...state, lastSuccessAt: at, lastHealthAt: at, updatedAt: at };
  }
  return {
    ...state,
    status: 'running',
    consecutiveFailures: 0,
    failureWindowStartedAt: undefined,
    lastSuccessAt: at,
    lastHealthAt: at,
    lastError: undefined,
    pauseReason: undefined,
    updatedAt: at,
  };
}

export function recordAdapterFailure(
  state: MessagingAdapterState,
  failure: AdapterFailure,
  at: string,
): MessagingAdapterState {
  if (isAdapterBlocked(state)) return { ...state, lastError: failure.error, lastHealthAt: at, updatedAt: at };
  state = { ...state, lastHealthAt: at };
  if (failure.kind === 'failed_before_dispatch') {
    return { ...state, lastError: failure.error, updatedAt: at };
  }
  if (failure.kind === 'unknown_after_dispatch') {
    return { ...state, status: 'degraded', lastError: failure.error, updatedAt: at };
  }

  const windowStart = state.failureWindowStartedAt ? new Date(state.failureWindowStartedAt).getTime() : Number.NaN;
  const current = new Date(at).getTime();
  const insideWindow = Number.isFinite(windowStart) && current - windowStart <= FAILURE_WINDOW_MS && current >= windowStart;
  const consecutiveFailures = insideWindow ? state.consecutiveFailures + 1 : 1;
  return {
    ...state,
    status: consecutiveFailures >= BREAKER_THRESHOLD ? 'paused_by_breaker' : 'degraded',
    consecutiveFailures,
    failureWindowStartedAt: insideWindow ? state.failureWindowStartedAt : at,
    lastError: failure.error,
    pauseReason: consecutiveFailures >= BREAKER_THRESHOLD ? '连续三次可重试渠道故障，适配器已自动熔断' : undefined,
    updatedAt: at,
  };
}
