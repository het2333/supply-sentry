import { createInterface } from 'node:readline';

/**
 * stdio MCP server（协议 shim）。
 *
 * 由 DSH runtime 的 mcp-client 以子进程方式 spawn，把 MCP 协议（JSON-RPC 2.0 逐行）
 * 转发到主进程的 HTTP 桥接器执行 —— 工具真正在我们的进程里跑（同一份状态 + 权限 + 记账）。
 *
 * 环境变量（由 cordis.yml 注入）：
 *   RW_BRIDGE_URL   主进程桥接器地址
 *   RW_BRIDGE_TOKEN 鉴权令牌
 *   RW_EMPLOYEE_ID  员工身份（权限校验用）
 */

const BRIDGE_URL = process.env['RW_BRIDGE_URL'] ?? '';
const TOKEN = process.env['RW_BRIDGE_TOKEN'] ?? '';
const EMPLOYEE_ID = process.env['RW_EMPLOYEE_ID'] ?? '';

interface MpcTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

async function bridge<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, ...body }),
  });
  return (await res.json()) as T;
}

function reply(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id: number, error: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error) } })}\n`);
}

async function handle(msg: Record<string, unknown>): Promise<void> {
  const id = typeof msg['id'] === 'number' ? msg['id'] : undefined;
  const method = String(msg['method'] ?? '');
  const params = (msg['params'] as Record<string, unknown> | undefined) ?? {};

  if (id === undefined) return; // 通知（initialized 等）忽略

  try {
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'readywork-tools', version: '0.1.0' },
      });
      return;
    }
    if (method === 'tools/list') {
      const r = await bridge<{ tools: MpcTool[] }>('/list', {});
      reply(id, { tools: r.tools });
      return;
    }
    if (method === 'tools/call') {
      const name = String(params['name'] ?? '');
      const args = (params['arguments'] as Record<string, unknown> | undefined) ?? {};
      const r = await bridge<{ ok: boolean; content: string }>('/call', { name, arguments: args, employeeId: EMPLOYEE_ID });
      reply(id, { content: [{ type: 'text', text: r.content }], isError: !r.ok });
      return;
    }
    replyError(id, `不支持的 MCP 方法: ${method}`);
  } catch (err) {
    replyError(id, err instanceof Error ? err.message : String(err));
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  void handle(msg);
});
