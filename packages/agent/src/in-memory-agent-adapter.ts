import type { AgentRequest, AgentResult, AgentRuntimePort } from '@readywork/core';

export type AgentDecisionHandler = (req: AgentRequest) => AgentResult | Promise<AgentResult>;

export interface InMemoryAgentOptions {
  defaultHandler?: AgentDecisionHandler;
  logger?: (line: string) => void;
}

/** 只用于单测和显式本地验证的确定性决策桩。 */
export class InMemoryAgentAdapter implements AgentRuntimePort {
  private handlers = new Map<string, AgentDecisionHandler>();

  constructor(private opts: InMemoryAgentOptions = {}) {}

  register(workerId: string, handler: AgentDecisionHandler): void {
    this.handlers.set(workerId, handler);
  }

  async execute(req: AgentRequest): Promise<AgentResult> {
    const handler = this.handlers.get(req.workerId) ?? this.opts.defaultHandler;
    if (!handler) {
      return { reasoning: `无 worker handler: ${req.workerId}`, actions: [], stateUpdates: {} };
    }
    const result = await handler(req);
    this.opts.logger?.(`[agent:${req.workerId}] ${result.reasoning}`);
    return result;
  }
}
