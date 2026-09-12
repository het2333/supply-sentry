import type { ContextSnapshot } from './context-types.js';
import type { EntityId } from './types.js';

/**
 * Agent Runtime 端口 —— Business Runtime 与 DeepSeek Harness 的边界。
 * 业务层只依赖此端口；V1 用确定性桩实现，之后替换为真实 DSH 适配器，业务零改动。
 */

export interface ToolDescriptor {
  id: string;
  name: string;
  actions: string[];
}

export interface SkillDescriptor {
  id: string;
  name: string;
}

export interface AgentRequest {
  employeeId: EntityId;
  taskId: EntityId;
  workerId: string;
  instruction: string;
  /** 权限范围内（spec.contextScope）的上下文快照 */
  contextSnapshot: ContextSnapshot;
  toolDescriptors: ToolDescriptor[];
  skillDescriptors: SkillDescriptor[];
  workspace: Record<string, unknown>;
}

/** Agent 输出的行动：只决定"做什么"，执行与权限校验由 Runtime 负责 */
export type AgentAction =
  | { type: 'tool'; tool: string; action: string; args: Record<string, unknown> }
  | { type: 'skill'; skill: string; input: Record<string, unknown> };

export interface AgentResult {
  reasoning: string;
  actions: AgentAction[];
  /** 直接写入任务工作区的状态更新 */
  stateUpdates: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface AgentRuntimePort {
  execute(req: AgentRequest): Promise<AgentResult>;
}
