import { createInterface } from 'node:readline';

const allowedHosts = new Set(JSON.parse(process.argv[2] ?? '[]'));
const lines = createInterface({ input: process.stdin });

function reply(id, ok, result, error) {
  process.stdout.write(`${JSON.stringify({ id, ok, ...(result ? { result } : {}), ...(error ? { error } : {}) })}\n`);
}

lines.on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    if (request.method === 'health') return reply(request.id, true, { allowedHosts: [...allowedHosts] });
    if (request.method === 'shutdown') return reply(request.id, true, {});
    if (request.method !== 'execute' || request.payload?.action !== 'request') return reply(request.id, false, undefined, '不支持的插件操作');
    const input = request.payload.input ?? {};
    const url = new URL(String(input.url ?? ''));
    if (!allowedHosts.has(url.hostname)) return reply(request.id, false, undefined, `目标主机未授权: ${url.hostname}`);
    const method = String(input.method ?? 'GET').toUpperCase();
    const response = await fetch(url, {
      method,
      headers: input.headers && typeof input.headers === 'object' ? input.headers : {},
      body: method === 'GET' || method === 'HEAD' || input.body === undefined ? undefined : typeof input.body === 'string' ? input.body : JSON.stringify(input.body),
      redirect: 'manual',
    });
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* 纯文本响应 */ }
    reply(request.id, true, { status: response.status, headers: Object.fromEntries(response.headers.entries()), body });
  } catch (error) {
    reply(request?.id ?? 'unknown', false, undefined, error instanceof Error ? error.message : String(error));
  }
});
