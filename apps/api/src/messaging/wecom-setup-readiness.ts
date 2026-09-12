const CALLBACK_PATH = '/wecom/callback';

export interface WecomSetupReadiness {
  readonly callbackUrl: string | null;
  readonly ready: boolean;
  readonly reason: string | null;
}

function privateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0.0.0.0' || normalized.endsWith('.local')) return true;
  const ipv4 = normalized.split('.').map((part) => Number(part));
  if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return ipv4[0] === 10
    || ipv4[0] === 127
    || (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31)
    || (ipv4[0] === 192 && ipv4[1] === 168);
}

export function resolveWecomSetupReadiness(value: string | undefined): WecomSetupReadiness {
  if (!value?.trim()) {
    return { callbackUrl: null, ready: false, reason: '尚未配置企业微信公网 HTTPS 回调地址' };
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || privateHost(url.hostname)) {
      return { callbackUrl: null, ready: false, reason: '企业微信回调地址必须是公网 HTTPS 地址' };
    }
    return { callbackUrl: new URL(CALLBACK_PATH, url.origin).toString(), ready: true, reason: null };
  } catch {
    return { callbackUrl: null, ready: false, reason: '企业微信回调地址格式无效' };
  }
}
