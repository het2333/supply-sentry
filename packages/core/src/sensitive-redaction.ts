const SECRET_NAME = /(?:^|[_-])(?:authorization|api[-_]?(?:key|token)|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|oauth[-_]?token|session[-_]?token|csrf[-_]?token|client[-_]?secret|private[-_]?key|secret|password|passwd|passphrase|credential|cookie)(?:$|[_-])/i;
const CREDENTIAL_ASSIGNMENT = /(["']?)(authorization(?:[-_]?code)?|api[-_]?key|(?:access[-_]?|refresh[-_]?)?token|(?:client[-_]?)?secret|password|passwd|passphrase|credential|cookie)\1(\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Basic|Bearer)\s+[^\s,;}&|]+|[^\s,;}&|]+)/gi;

function isSecretName(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return /^token$/iu.test(normalized) || SECRET_NAME.test(normalized);
}

function redactAssignedCredentials(value: string): string {
  return value.replace(CREDENTIAL_ASSIGNMENT, (match, keyQuote: string, key: string, separator: string) => {
    const assignedValue = match.slice(keyQuote.length + key.length + keyQuote.length + separator.length);
    const valueQuote = assignedValue.startsWith('"') ? '"' : assignedValue.startsWith("'") ? "'" : '';
    return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`;
  });
}

/** 防止日志、持久化错误和外部连接器消息带出令牌、密码或部署密钥。 */
export function redactSensitive(value: unknown, maxLength = 800): string {
  let message = value instanceof Error ? value.message : String(value);
  message = message
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[REDACTED]@');
  message = redactAssignedCredentials(message)
    .replace(/\bBearer\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|[A-Za-z0-9._~+/=-]+)/gi, 'Bearer [REDACTED]');

  for (const [name, secret] of Object.entries(process.env)) {
    if (!isSecretName(name) || !secret || secret.length < 4) continue;
    message = message.split(secret).join('[REDACTED]');
  }
  return message.slice(0, maxLength);
}

export function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSecretName(key) ? '[REDACTED]' : redactSensitiveValue(item, depth + 1),
    ]));
  }
  return typeof value === 'string' ? redactSensitive(value, 20_000) : value;
}
