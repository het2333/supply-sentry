import type { AgentAction, AgentRequest, AgentResult, AgentRuntimePort } from '@readywork/core';
import { HarnessRuntime, type HarnessRuntimeLike, type HarnessRuntimeOptions } from './harness-runtime.js';

/**
 * DeepSeek Harness Adapter —— AgentRuntimePort 的真实实现。
 *
 * 边界（框架原则）：Harness 管"怎么思考和行动"，Runtime 管"业务走到哪一步"。
 * 因此本适配器只做三件事：
 *   1. 把 AgentRequest 组装为 Harness 的一次会话（员工身份 + 权限内上下文快照 + 工具/技能清单）
 *   2. 驱动 DSH runtime 执行一个 agent 回合（JSON-RPC over stdio）
 *   3. 把模型输出的决策 JSON 解析为 AgentResult（actions/stateUpdates），
 *      工具与技能的执行、权限校验、成本记账仍由 WorkflowEngine 负责
 *
 * 运行方式：
 *   - 无 API key：配合 apps/mock-model 的 OpenAI 兼容端点（DEEPSEEK_BASE_URL）做确定性验证
 *   - 有 API key：DEEPSEEK_API_KEY + DEEPSEEK_BASE_URL 指向真实服务
 */

const SYSTEM_PROMPT_TEMPLATE = `你是 readywork AI Workforce OS 中的一名 AI 员工。你只负责"决策与判断"，执行由 Business Runtime 完成。

[身份] {identity}
[目标] {goals}
[上下文快照] {snapshot}
[工作区] {workspace}
[可用工具] {tools}
[可用技能] {skills}
[输出契约] 你的回复必须只包含一个 JSON 对象，不要任何其他文字或 Markdown 围栏：
{"reasoning": "一句话说明判断依据", "actions": [], "stateUpdates": {"键":"值"}, "output": {}}

规则（重要，按任务类型区分）：
1. 分析类任务（分类/提取/比较/核对/推荐）：把结论**直接写入 stateUpdates**，actions 留空。常用键名：分类 classification、汇总文本 email_replies、推荐供应商 recommendedSupplier、提取正文 replyText。
2. 操作类任务（指令明确要求"发送/更新/联系/生成并发送"）：把操作放入 actions，例如 {"type":"skill","skill":"compose-follow-up","input":{...}} 或 {"type":"tool","tool":"email","action":"send","args":{...}}。
3. 不要伪造执行结果；无法判断时 stateUpdates 为空并在 reasoning 说明。`;

/** 系统提示里的固定标记（mock-model 依赖这些标记解析上下文） */
export const PROMPT_MARKERS = ['[身份]', '[目标]', '[上下文快照]', '[工作区]', '[可用工具]', '[可用技能]'] as const;

export interface DeepSeekHarnessAdapterOptions {
  /** runtime 启动规格；单 runtime 模式直接复用，runtimeFactory 模式用于启动预检。 */
  runtimeOptions?: HarnessRuntimeOptions;
  /**
   * 按员工和 worker 创建 runtime。workerId 被纳入进程缓存键，避免同一员工的
   * 高风险 worker 复用到低预算/低推理强度的模型进程（或反过来）。
   */
  runtimeFactory?: (employeeId: string, workerId: string) => HarnessRuntimeOptions;
  /** 注入 runtime 实例（测试用） */
  runtime?: HarnessRuntimeLike;
  /** 回合内事件回调（观察 MCP tool_call 等） */
  onEvents?: (employeeId: string, events: unknown[]) => void;
  /** 自定义系统提示组装（默认模板含固定标记，mock-model 依赖这些标记） */
  systemPrompt?: (req: AgentRequest) => string;
  /** 自定义决策解析 */
  parseDecision?: (text: string) => AgentResult;
  logger?: (line: string) => void;
  turnTimeoutMs?: number;
}

export class DeepSeekHarnessAdapter implements AgentRuntimePort {
  private runtimes = new Map<string, HarnessRuntimeLike>();
  private sessionSeq = 0;
  private closed = false;
  private started = false;
  private startPromise: Promise<void> | undefined;

  constructor(private opts: DeepSeekHarnessAdapterOptions) {}

  private runtimeFor(employeeId: string, workerId = ''): HarnessRuntimeLike {
    if (this.closed) throw new Error('DeepSeek Harness Adapter 已关闭');
    if (this.opts.runtime) return this.opts.runtime;
    if (this.opts.runtimeFactory) {
      const key = `${employeeId}\u0000${workerId}`;
      let r = this.runtimes.get(key);
      if (!r) {
        r = new HarnessRuntime(this.opts.runtimeFactory(employeeId, workerId));
        this.runtimes.set(key, r);
      }
      return r;
    }
    let r = this.runtimes.get('*');
    if (!r) {
      if (!this.opts.runtimeOptions) throw new Error('DeepSeek Harness Adapter 缺少 runtimeOptions');
      r = new HarnessRuntime(this.opts.runtimeOptions);
      this.runtimes.set('*', r);
    }
    return r;
  }

  async execute(req: AgentRequest): Promise<AgentResult> {
    const system = this.systemPrompt(req);
    const user = `[任务指令] ${req.instruction}`;
    const sessionId = `rw-${++this.sessionSeq}-${Date.now().toString(36)}`;
    this.opts.logger?.(`[dsh:${req.workerId}] 回合开始 (session ${sessionId})`);
    const runtime = this.runtimeFor(req.employeeId, req.workerId);
    const result = await runtime.prompt(sessionId, [
      { type: 'text', text: system },
      { type: 'text', text: user },
    ]);
    this.opts.logger?.(`[dsh:${req.workerId}] 回合结束 (${result.finalResponse.length} chars, events=${result.events.length})`);
    this.opts.onEvents?.(req.employeeId, result.events);
    if (!result.finalResponse.trim()) {
      const failureCode = turnFailureCode(result.events);
      if (failureCode) throw new Error(`DSH 回合失败 (code=${failureCode}, session ${sessionId})`);
      throw new Error(`DSH 回合未产生文本输出 (session ${sessionId})`);
    }
    assertDecisionOnlyEvents(result.events);
    const parsed = this.parseDecision(result.finalResponse);
    this.opts.logger?.(`[dsh:${req.workerId}] 决策: ${parsed.reasoning} (actions=${parsed.actions.length})`);
    return parsed;
  }

  /**
   * 可选预热；execute 仍会在未预热时自动启动。
   * 按员工隔离模式用 runtimeOptions 启动并立即关闭一次预检进程，验证真实 DSH
   * composition 可以 initialize；不会创建或缓存伪造的 `*` 员工 runtime。
   */
  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new Error('DeepSeek Harness Adapter 已关闭');
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
      if (this.closed) throw new Error('DeepSeek Harness Adapter 已关闭');
      this.started = true;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    if (this.opts.runtime) {
      await this.opts.runtime.start();
      return;
    }
    if (this.opts.runtimeFactory) {
      if (!this.opts.runtimeOptions) return;
      const probe = new HarnessRuntime(this.opts.runtimeOptions);
      try {
        await probe.start();
      } finally {
        await probe.close();
      }
      return;
    }
    if (this.opts.runtimeOptions) await this.runtimeFor('*').start();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.startPromise?.catch(() => {});
    const runtimes = new Set(this.runtimes.values());
    if (this.opts.runtime) runtimes.add(this.opts.runtime);
    const results = await Promise.allSettled([...runtimes].map((r) => r.close()));
    this.runtimes.clear();
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
    if (errors.length > 0) throw new AggregateError(errors, 'DeepSeek Harness Adapter 关闭不完整');
  }

  // ---------------------------------------------------------------- 默认组装与解析

  private systemPrompt(req: AgentRequest): string {
    if (this.opts.systemPrompt) return this.opts.systemPrompt(req);
    const identity = JSON.stringify({ id: req.employeeId, name: 'AI 员工', role: '企业 AI 员工' });
    return SYSTEM_PROMPT_TEMPLATE.replace('{identity}', identity)
      .replace('{goals}', '[]')
      .replace('{snapshot}', JSON.stringify(req.contextSnapshot))
      .replace('{workspace}', JSON.stringify(req.workspace))
      .replace('{tools}', JSON.stringify(req.toolDescriptors))
      .replace('{skills}', JSON.stringify(req.skillDescriptors));
  }

  private parseDecision(text: string): AgentResult {
    if (this.opts.parseDecision) return this.opts.parseDecision(text);
    return parseAgentDecision(text);
  }
}

/**
 * Readywork 默认 Harness 不拥有业务工具。若自定义 DSH 组合意外装载了工具，
 * 即使模型最终给出了合法 JSON，也拒绝接纳该回合，避免把越界执行伪装成动作建议。
 */
function assertDecisionOnlyEvents(events: unknown[]): void {
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    const value = event as Record<string, unknown>;
    if (value['type'] !== 'tool/call') continue;
    const data = value['data'];
    const name = data !== null && typeof data === 'object' ? (data as Record<string, unknown>)['name'] : undefined;
    throw new Error(`DSH 安全边界违规：decision-only runtime 产生了工具调用${typeof name === 'string' ? ` (${name})` : ''}`);
  }
}

function turnFailureCode(events: unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event === null || typeof event !== 'object') continue;
    const value = event as Record<string, unknown>;
    if (value['type'] !== 'turn/end') continue;
    const data = value['data'];
    if (data === null || typeof data !== 'object') return undefined;
    const reason = (data as Record<string, unknown>)['reason'];
    if (reason === null || typeof reason !== 'object' || (reason as Record<string, unknown>)['kind'] !== 'error') return undefined;
    const error = (reason as Record<string, unknown>)['error'];
    if (error === null || typeof error !== 'object') return 'UNKNOWN';
    const code = String((error as Record<string, unknown>)['code'] ?? 'UNKNOWN').toUpperCase();
    return /^[A-Z0-9_-]{1,64}$/.test(code) ? code : 'UNKNOWN';
  }
  return undefined;
}

/** 解析模型输出：优先 ```json 围栏，其次整段 JSON */
export function parseAgentDecision(text: string): AgentResult {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1]! : text).trim();
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error(`AI 决策解析失败（非 JSON 输出）: ${text.slice(0, 200)}`);
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`AI 决策格式错误（应为 JSON 对象）: ${text.slice(0, 200)}`);
  }
  const o = obj as Record<string, unknown>;
  const actions = Array.isArray(o['actions']) ? (o['actions'] as AgentAction[]) : [];
  const stateUpdates = o['stateUpdates'] !== undefined && typeof o['stateUpdates'] === 'object' ? (o['stateUpdates'] as Record<string, unknown>) : {};
  return {
    reasoning: String(o['reasoning'] ?? ''),
    actions,
    stateUpdates,
    output: o['output'] !== undefined && typeof o['output'] === 'object' ? (o['output'] as Record<string, unknown>) : undefined,
  };
}
