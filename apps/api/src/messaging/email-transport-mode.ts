export type EmailTransportMode = 'native' | 'hermes';

export function resolveEmailTransportMode(
  env: Readonly<Record<string, string | undefined>>,
): EmailTransportMode {
  const raw = env['READYWORK_EMAIL_TRANSPORT_MODE'];
  const mode = raw === undefined ? 'native' : raw.trim().toLowerCase();
  if (mode === 'native' || mode === 'hermes') return mode;
  throw new Error('READYWORK_EMAIL_TRANSPORT_MODE 只允许 native 或 hermes，禁止双路发送');
}
