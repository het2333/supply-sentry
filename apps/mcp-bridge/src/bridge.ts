import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EntityId, RuntimeHub } from '@readywork/core';
import { nowIso } from '@readywork/core';
import type { SkillRegistry } from '@readywork/skills';
import type { ToolRegistry } from '@readywork/tools';

/**
 * MCP 工具桥（主进程侧执行器）。
 *
 * 职责：DSH runtime 通过 stdio MCP server 子进程（server.ts）转发 tools/list 与 tools/call，
 * 本桥接器在**我们的进程**里真正执行 —— 复用同一份 ToolRegistry / SkillRegistry / 状态，
 * 并在工具执行前走 PolicyEngine 权限校验、执行后记账（预算 + 成本 + tool.called 事件）。
 * 这正是"Harness 负责决策、Runtime 负责执行"边界在 MCP 下的落点。
 */

export interface BridgeToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type BridgeCallEntry = { kind: 'tool'; toolId: string; action: string } | { kind: 'skill'; skillId: string };

export interface McpBridgeServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '_');
}

/** 工具/技能 → MCP 工具名（DSH 侧公开名为 mcp__<serverName>__<此名>） */
export function buildCallMap(tools: ToolRegistry, skills: SkillRegistry): Map<string, BridgeCallEntry> {
  const map = new Map<string, BridgeCallEntry>();
  for (const t of tools.list()) {
    for (const action of t.actions) map.set(`${t.id}__${sanitize(action)}`, { kind: 'tool', toolId: t.id, action });
  }
  for (const s of skills.list()) map.set(`skill__${sanitize(s.id)}`, { kind: 'skill', skillId: s.id });
  return map;
}

export function buildToolInfos(tools: ToolRegistry, skills: SkillRegistry): BridgeToolInfo[] {
  const infos: BridgeToolInfo[] = [];
  for (const t of tools.list()) {
    for (const action of t.actions) {
      infos.push({
        name: `${t.id}__${sanitize(action)}`,
        description: `${t.name} · 动作 ${action}`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      });
    }
  }
  for (const s of skills.list()) {
    infos.push({
      name: `skill__${sanitize(s.id)}`,
      description: s.name,
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    });
  }
  return infos;
}

interface ExecuteContext {
  hub: RuntimeHub;
  tools: ToolRegistry;
  skills: SkillRegistry;
}

async function executeCall(
  ctx: ExecuteContext,
  entry: BridgeCallEntry,
  args: Record<string, unknown>,
  employeeId: EntityId,
): Promise<{ ok: boolean; content: string }> {
  if (entry.kind === 'skill') {
    const result = await ctx.skills.invoke(entry.skillId, args, { employeeId, taskId: '' });
    return { ok: true, content: JSON.stringify(result) };
  }
  const emp = ctx.hub.org.getAI(employeeId);
  const spec = emp ? ctx.hub.specs.get(emp.specId) : undefined;
  if (!emp || !spec) return { ok: false, content: JSON.stringify({ error: `未知员工: ${employeeId}` }) };
  if (!ctx.hub.policy.can(spec.permissions, entry.action, entry.toolId)) {
    return { ok: false, content: JSON.stringify({ error: `权限拒绝: ${employeeId} 无权限调用 ${entry.toolId}.${entry.action}` }) };
  }
  const res = await ctx.tools.execute(entry.toolId, entry.action, args, {
    employeeId,
    businessObjectId: typeof args['poId'] === 'string' ? (args['poId'] as string) : undefined,
  });
  const cost = res.cost ?? 0;
  if (cost > 0) {
    const cap = spec.budget?.monthlyCap;
    const currency = spec.budget?.currency ?? 'CNY';
    ctx.hub.budget.record(employeeId, cost, currency, cap);
    emp.stats.totalCost += cost;
  }
  ctx.hub.bus.emit({ type: 'tool.called', employeeId, tool: entry.toolId, action: entry.action, ok: res.ok, cost, at: nowIso() });
  return { ok: res.ok, content: JSON.stringify(res.data ?? { ok: res.ok, error: res.error }) };
}

export function createBridgeServer(opts: {
  hub: RuntimeHub;
  tools: ToolRegistry;
  skills: SkillRegistry;
  token?: string;
  logger?: (line: string) => void;
}): Promise<McpBridgeServer> {
  const token = opts.token ?? `rw-${Math.random().toString(36).slice(2)}`;
  const callMap = buildCallMap(opts.tools, opts.skills);
  const toolInfos = buildToolInfos(opts.tools, opts.skills);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (body['token'] !== token) return send(401, { error: 'invalid token' });

    try {
      if (req.url === '/list') return send(200, { tools: toolInfos });
      if (req.url === '/call') {
        const name = String(body['name'] ?? '');
        const employeeId = String(body['employeeId'] ?? '');
        const args = (body['arguments'] as Record<string, unknown> | undefined) ?? {};
        const entry = callMap.get(name);
        if (!entry) return send(200, { ok: false, content: JSON.stringify({ error: `未知工具: ${name}` }) });
        const r = await executeCall({ hub: opts.hub, tools: opts.tools, skills: opts.skills }, entry, args, employeeId);
        opts.logger?.(`[mcp-bridge] ${name}(${employeeId}) → ${r.ok ? 'ok' : 'FAIL'} ${r.content.slice(0, 80)}`);
        return send(200, r);
      }
      send(404, { error: `not found: ${req.url}` });
    } catch (err) {
      send(200, { ok: false, content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      if (a === null || typeof a === 'string') return reject(new Error('bridge 未绑定端口'));
      resolve({
        url: `http://127.0.0.1:${a.port}`,
        port: a.port,
        token,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
