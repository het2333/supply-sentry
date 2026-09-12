import { createHash } from 'node:crypto';
import type { AppendTwinAgentEventInput, TwinAgentEventType } from '@readywork/core';
import { sanitizeContextValue } from './context-access-policy.js';

export const TWIN_AGENT_EVENT_TYPES = [
  'context_read', 'extraction', 'decision', 'recommendation',
  'action_requested', 'action_result', 'human_feedback', 'business_outcome',
] as const satisfies readonly TwinAgentEventType[];

const TWIN_AGENT_EVENT_TYPE_SET = new Set<string>(TWIN_AGENT_EVENT_TYPES);

export function assertTwinAgentEventType(value: string): asserts value is TwinAgentEventType {
  if (!TWIN_AGENT_EVENT_TYPE_SET.has(value)) throw new Error('Twin Agent Event 事件类型不受支持');
}

export function agentEventIdempotencyKey(event: AppendTwinAgentEventInput): string {
  const tuple = [
    event.runId,
    event.taskId,
    event.eventType,
    event.promptHash ?? null,
    event.responseHash ?? null,
    event.actionName ?? null,
  ];
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

export function sameAgentEventIdempotencyTuple(
  left: AppendTwinAgentEventInput,
  right: AppendTwinAgentEventInput,
): boolean {
  return agentEventIdempotencyKey(left) === agentEventIdempotencyKey(right);
}

export function sanitizeAgentEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizeContextValue(payload, {
    includeContactDetails: true,
    includeCommercialTerms: true,
  }) as Record<string, unknown>;
}
