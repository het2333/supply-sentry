import { redactSensitive } from '@readywork/core';

export { redactSensitive, redactSensitiveValue } from '@readywork/core';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    readonly code: string,
  ) {
    super(publicMessage);
    this.name = 'HttpError';
  }
}

export function publicIntegrationError(error: unknown): string {
  const message = redactSensitive(error).toLowerCase();
  if (message.includes('timeout') || message.includes('timed out') || message.includes('超时')) return '外部服务请求超时';
  if (message.includes('aborted') || message.includes('abort')) return '外部服务请求已取消';
  return '外部服务请求失败';
}
