import { redactSensitive, redactSensitiveValue } from '@readywork/core';

/** The single durable messaging error boundary; retain diagnostics, never mailbox or secrets. */
export function safeMessagingError(error: unknown): string {
  const value = error instanceof Error
    ? { message: error.message, cause: error.cause }
    : error;
  return redactSensitive(typeof value === 'string' ? value : JSON.stringify(redactSensitiveValue(value)), 2_000)
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[REDACTED_EMAIL]')
    .slice(0, 500);
}
