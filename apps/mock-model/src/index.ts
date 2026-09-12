import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * OpenAI 兼容 mock 模型端点（SSE 流式 /chat/completions）。
 *
 * 两种模式：
 * - 'decision'（默认）：单轮产出 JSON 决策（动作由引擎执行）——demo:dsh 用
 * - 'mcp'：对"延期"场景产出原生 tool_calls（mcp__rw__skill__compose_follow_up →
 *         mcp__rw__email__send → 最终决策），验证 DSH 经 MCP 原生调用我们的工具——demo:mcp 用
 *
 * 决策依据：适配器系统提示的固定标记段（[身份]/[上下文快照]/[工作区]/[可用工具]/[可用技能]）+ 用户指令。
 */

export interface MockModelServer {
  url: string;
  port: number;
  requestCount: () => number;
  close(): Promise<void>;
}

export interface MockModelServerOptions {
  logger?: (line: string) => void;
  mode?: 'decision' | 'mcp';
}

interface ParsedPrompt {
  snapshot?: { entities?: { id: string; type: string; attributes: Record<string, unknown> }[] };
  workspace?: Record<string, unknown>;
  instruction?: string;
}

// ---------------------------------------------------------------- 场景决策（decision 模式）

function classifyRequisition(description: string): string {
  return description.includes('设备') || description.includes('机器')
    ? '设备'
    : description.includes('原料')
      ? '原料'
      : description.includes('包')
        ? '包材'
        : 'MRO';
}

export function decide(p: ParsedPrompt): Record<string, unknown> {
  const instruction = p.instruction ?? '';
  const entities = p.snapshot?.entities ?? [];
  const emails = entities.filter((e) => e.type === 'email');
  const lastEmail = emails[emails.length - 1];
  const supplier = entities.find((e) => e.type === 'supplier');
  const workspace = p.workspace ?? {};

  if (instruction.includes('分类')) {
    const req = entities.find((e) => e.type === 'requisition');
    const description = String(req?.attributes['description'] ?? '');
    const category = classifyRequisition(description);
    return { reasoning: `需求「${description.slice(0, 24)}${description.length > 24 ? '…' : ''}」→ 分类：${category}`, actions: [], stateUpdates: { classification: category } };
  }
  if (instruction.includes('报价邮件')) {
    const bodies = emails.map((e) => `${String(e.attributes['from'] ?? '')}: ${String(e.attributes['body'] ?? '')}`).join('\n');
    return { reasoning: `收集到 ${emails.length} 封供应商报价邮件`, actions: [], stateUpdates: { email_replies: bodies } };
  }
  if (instruction.includes('比较')) {
    const parsed = workspace['parsedQuotes'] as { quotes?: { supplierId: string; unitPrice: number; deliveryDays: number }[] } | undefined;
    const quotes = parsed?.quotes ?? [];
    if (quotes.length === 0) return { reasoning: '没有可比较的报价', actions: [], stateUpdates: { recommendedSupplier: '' } };
    const best = [...quotes].sort((a, b) => a.unitPrice - b.unitPrice)[0]!;
    return { reasoning: `比较 ${quotes.length} 家报价（最低 ${best.unitPrice} 元/${best.deliveryDays}天）→ 推荐 ${best.supplierId}`, actions: [], stateUpdates: { recommendedSupplier: best.supplierId } };
  }
  if (instruction.includes('核对')) {
    return {
      reasoning: lastEmail ? `已收到供应商邮件「${String(lastEmail.attributes['subject'] ?? '')}」` : '尚未收到供应商回复',
      actions: [],
      stateUpdates: { replyReceived: Boolean(lastEmail), latestReplySubject: lastEmail?.attributes['subject'] },
    };
  }
  if (instruction.includes('提取')) {
    return { reasoning: '提取最新供应商邮件正文用于交期解析', actions: [], stateUpdates: { replyText: String(lastEmail?.attributes['body'] ?? '') } };
  }
  if (instruction.includes('延期')) {
    const delay = workspace['delay'] as { days?: number } | undefined;
    const poData = workspace['tool.erp.po.get'] as { po?: { id?: string } } | undefined;
    const poId = poData?.po?.id ?? '';
    return {
      reasoning: `延期 ${delay?.days ?? 0} 天 → 生成催交邮件并发送给 ${String(supplier?.attributes['name'] ?? '供应商')}`,
      actions: [
        { type: 'skill', skill: 'compose-follow-up', input: { poId, supplierName: supplier?.attributes['name'] ?? '供应商', delayDays: delay?.days ?? 0 } },
        { type: 'tool', tool: 'email', action: 'send', args: { to: String(supplier?.attributes['email'] ?? ''), subject: `PO-${poId} 延期跟进`, body: '{{skill.compose-follow-up.text}}' } },
      ],
      stateUpdates: { followUpSent: true },
    };
  }
  return { reasoning: '未识别指令场景，按无行动处理', actions: [], stateUpdates: {} };
}

// ---------------------------------------------------------------- 原生 tool-calling（mcp 模式）

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}
type MockTurn = { kind: 'decision'; decision: Record<string, unknown> } | { kind: 'tool_calls'; calls: ToolCall[] };

function mcpTurn(p: ParsedPrompt, lastToolResult: unknown): MockTurn {
  if (lastToolResult !== undefined) {
    const r = (lastToolResult ?? {}) as Record<string, unknown>;
    const supplier = p.snapshot?.entities?.find((e) => e.type === 'supplier');
    const poData = p.workspace?.['tool.erp.po.get'] as { po?: { id?: string } } | undefined;
    const poId = poData?.po?.id ?? '';
    if (typeof r['text'] === 'string') {
      // 刚拿到催交文本 → 原生调用邮件工具
      return {
        kind: 'tool_calls',
        calls: [{
          id: `call_${Date.now()}_email`,
          name: 'mcp__rw__email__send',
          arguments: { to: String(supplier?.attributes['email'] ?? ''), subject: `PO-${poId} 延期跟进`, body: String(r['text']) },
        }],
      };
    }
    // 邮件已发 → 最终决策
    return {
      kind: 'decision',
      decision: {
        reasoning: '已通过 MCP 原生调用 compose-follow-up 技能与 email 工具',
        actions: [],
        stateUpdates: { followUpSent: true, mcpTools: ['skill__compose_follow_up', 'email__send'] },
      },
    };
  }
  const delay = p.workspace?.['delay'] as { days?: number } | undefined;
  const supplier = p.snapshot?.entities?.find((e) => e.type === 'supplier');
  const poData = p.workspace?.['tool.erp.po.get'] as { po?: { id?: string } } | undefined;
  return {
    kind: 'tool_calls',
    calls: [{
      id: `call_${Date.now()}_skill`,
      name: 'mcp__rw__skill__compose_follow_up',
      arguments: { poId: poData?.po?.id ?? '', supplierName: String(supplier?.attributes['name'] ?? '供应商'), delayDays: delay?.days ?? 0 },
    }],
  };
}

// ---------------------------------------------------------------- prompt 解析

function parsePrompt(text: string): ParsedPrompt {
  const out: ParsedPrompt = {};
  const get = (marker: string): unknown => {
    const line = text.split('\n').find((l) => l.startsWith(marker));
    if (!line) return undefined;
    try {
      return JSON.parse(line.slice(marker.length).trim());
    } catch {
      return undefined;
    }
  };
  const snapshot = get('[上下文快照]');
  const workspace = get('[工作区]');
  if (snapshot !== undefined) out.snapshot = snapshot as ParsedPrompt['snapshot'];
  if (workspace !== undefined) out.workspace = workspace as Record<string, unknown>;
  out.instruction = text.match(/\[任务指令\]\s*([^\n]+)/)?.[1] ?? '';
  return out;
}

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

// ---------------------------------------------------------------- SSE 服务

export function createMockModelServer(opts: MockModelServerOptions = {}): Promise<MockModelServer> {
  const mode = opts.mode ?? 'decision';
  let requests = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
    });
    req.on('end', () => {
      requests += 1;
      let payload: { messages?: ChatMessage[]; stream?: boolean } = {};
      try {
        payload = JSON.parse(body) as { messages?: ChatMessage[]; stream?: boolean };
      } catch {
        payload = {};
      }
      const messages = payload.messages ?? [];
      const text = messages
        .map((m) => {
          if (typeof m.content === 'string') return m.content;
          if (Array.isArray(m.content)) return m.content.map((b) => (b !== null && typeof b === 'object' ? String((b as Record<string, unknown>)['text'] ?? '') : '')).join('\n');
          return '';
        })
        .join('\n');
      const last = messages[messages.length - 1];
      const lastIsTool = last?.role === 'tool';

      let turn: MockTurn;
      if (mode === 'mcp') {
        const p = parsePrompt(text);
        if (p.instruction?.includes('延期')) {
          let result: unknown;
          if (lastIsTool) {
            try {
              result = JSON.parse(String(last?.content ?? ''));
            } catch {
              result = undefined;
            }
          }
          turn = mcpTurn(p, result);
        } else {
          turn = { kind: 'decision', decision: decide(p) };
        }
      } else {
        turn = { kind: 'decision', decision: decide(parsePrompt(text)) };
      }

      opts.logger?.(`[mock-model:${mode}] #${requests} → ${turn.kind}${turn.kind === 'tool_calls' ? ' ' + turn.calls.map((c) => c.name).join(',') : ''}`);

      if (payload.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(turn.kind === 'decision' ? { choices: [{ message: { role: 'assistant', content: JSON.stringify(turn.decision) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50 } } : { choices: [{ message: { role: 'assistant', content: null, tool_calls: turn.calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (turn.kind === 'decision') {
        const decision = JSON.stringify(turn.decision);
        res.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n');
        res.write(`data: {"choices":[{"delta":{"content":${JSON.stringify(decision)}}}]}\n\n`);
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n');
      } else {
        res.write('data: {"choices":[{"delta":{"role":"assistant","content":null}}]}\n\n');
        res.write(`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${turn.calls[0]!.id}","type":"function","function":{"name":"${turn.calls[0]!.name}","arguments":${JSON.stringify(JSON.stringify(turn.calls[0]!.arguments))}}}]}}]}\n\n`);
        res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\n');
      }
      res.end('data: [DONE]\n\n');
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('mock 模型服务器未绑定 TCP 端口'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        port: address.port,
        requestCount: () => requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// 独立运行：pnpm mock-model
const isMain = process.argv[1] !== undefined && process.argv[1].includes('mock-model');
if (isMain) {
  const server = await createMockModelServer({ logger: (l) => console.log(l) });
  console.log(`mock-model (OpenAI 兼容) → ${server.url}  (直接 POST /chat/completions 可测试)`);
}
