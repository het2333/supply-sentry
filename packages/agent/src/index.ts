export type { AgentRequest, AgentResult, AgentRuntimePort } from '@readywork/core';

export type { HarnessRuntimeLike, HarnessRuntimeOptions, HarnessPromptResult } from './harness-runtime.js';
export { HarnessRuntime, HarnessRuntimeError, finalResponseText } from './harness-runtime.js';
export type { DeepSeekHarnessAdapterOptions } from './deepseek-harness-adapter.js';
export { DeepSeekHarnessAdapter, parseAgentDecision } from './deepseek-harness-adapter.js';
export type {
  AgentRuntimeConfig,
  AgentRuntimeDescription,
  AgentRuntimeHealth,
  AgentRuntimeHealthStatus,
  AgentRuntimeKind,
  AgentRuntimeManagerOptions,
  CreateDefaultAgentRuntimeOptions,
  DshAgentProfile,
  DshAgentRoutingConfig,
  DshReasoningEffort,
  DshAgentRuntimeConfig,
  InMemoryAgentRuntimeConfig,
  LoadAgentRuntimeConfigOptions,
} from './runtime-manager.js';
export { AgentRuntimeConfigError, AgentRuntimeManager, createDefaultAgentRuntime, loadAgentRuntimeConfig, routeAgentProfile } from './runtime-manager.js';
export type { AgentDecisionHandler, InMemoryAgentOptions } from './in-memory-agent-adapter.js';
export { InMemoryAgentAdapter } from './in-memory-agent-adapter.js';

/**
 * Agent Runtime Adapter。
 *
 * - InMemoryAgentAdapter —— 确定性决策桩（无 LLM），跑通验证链
 * - DeepSeekHarnessAdapter —— 真实接入 DeepSeek Harness（本仓自实现的 JSON-RPC stdio 客户端，
 *   协议与官方 @deepseek-ai/dsh-sdk-client 一致）。无 API key 时配合 apps/mock-model 验证。
 */
