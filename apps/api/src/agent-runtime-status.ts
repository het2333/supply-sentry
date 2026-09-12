import { existsSync } from 'node:fs';
import { loadAgentRuntimeConfig } from '@readywork/agent';

export type AgentRuntimeReadiness = 'ready' | 'unconfigured' | 'unavailable' | 'error';
export type AgentRuntimeKind = 'deepseek-harness' | 'inmemory';

export interface AgentRuntimeStatus {
  runtime: AgentRuntimeKind;
  provider: string;
  model: string;
  readiness: AgentRuntimeReadiness | 'not_observed';
  isolation: 'subprocess' | 'in_process';
  /** Only a bounded, credential-redacted diagnostic is returned. */
  error?: string;
  // Kept for older console clients.
  role: 'ai-kernel';
  default: boolean;
  configured: boolean;
  available: boolean;
  status: AgentRuntimeReadiness;
  source?: 'legacy-agent' | 'temporal-worker-config';
  observed?: boolean;
  configuration?: 'valid' | 'invalid';
  note?: string;
}

type RuntimeLike = {
  constructor?: { name?: string };
  getDescription?: () => unknown;
  getHealth?: () => unknown;
};

function safeError(value: unknown, env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let message = String(value);
  const configValues = Object.entries(env)
    .filter(([key, item]) => item && (key.startsWith('READYWORK_DSH_') || key.startsWith('DEEPSEEK_') || /(?:api[_-]?key|token|secret|password)/i.test(key)))
    .map(([, item]) => item as string)
    .sort((a, b) => b.length - a.length);
  for (const item of configValues) message = message.split(item).join('[REDACTED]');
  return message
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(?:DEEPSEEK_API_KEY|DEEPSEEK_BASE_URL|READYWORK_DSH_[A-Z_]+)=\S+/gi, '[REDACTED]')
    .slice(0, 500);
}

/** Build a public runtime contract without exposing process environment or credentials. */
export function describeAgentRuntime(runtime: unknown, env: Readonly<Record<string, string | undefined>> = process.env): AgentRuntimeStatus {
  const value = runtime as RuntimeLike;
  const description = value.getDescription?.() as {
    kind?: string; implementation?: string; provider?: string; model?: string;
  } | undefined;
  const health = value.getHealth?.() as { status?: string; detail?: unknown } | undefined;
  const name = `${description?.implementation ?? ''} ${value.constructor?.name ?? ''}`.toLowerCase();
  const isHarness = description?.kind === 'dsh' || name.includes('deepseek') || name.includes('harness');
  const runtimeKind: AgentRuntimeKind = isHarness ? 'deepseek-harness' : 'inmemory';
  const configured = isHarness
    ? Boolean(env['DEEPSEEK_API_KEY'] || env['DEEPSEEK_BASE_URL'])
    : true;
  const command = env['READYWORK_DSH_COMMAND']?.trim();
  const available = isHarness ? Boolean(!command || !command.includes('/') || existsSync(command)) : true;
  const healthError = safeError(health?.detail, env);
  const readiness: AgentRuntimeReadiness = healthError || health?.status === 'unhealthy'
    ? 'error'
    : health?.status === 'closed' ? 'unavailable'
      : !configured ? 'unconfigured'
        : !available ? 'unavailable'
          : 'ready';
  const note = isHarness
    ? readiness === 'unconfigured' ? '请配置 Harness runtime 与模型服务凭据'
      : readiness === 'unavailable' ? 'Harness runtime 命令不可用，请检查路径或进程环境'
        : undefined
    : '当前使用确定性内存运行时';
  return {
    runtime: runtimeKind,
    provider: description?.provider ?? (isHarness ? 'deepseek-harness' : 'inmemory'),
    model: description?.model ?? (isHarness ? (env['DEEPSEEK_MODEL'] ?? 'deepseek-v4-flash') : 'inmemory-deterministic'),
    readiness,
    isolation: isHarness ? 'subprocess' : 'in_process',
    ...(healthError ? { error: healthError } : {}),
    role: 'ai-kernel', default: !isHarness, configured, available, status: readiness,
    ...(note ? { note } : {}),
  };
}

/**
 * Describe the Runtime that the Temporal worker will construct. The API process
 * does not own that worker, so readiness is deliberately not reported as ready.
 */
export function describeTemporalWorkerRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
  observation: { workerObserved?: boolean } = {},
): AgentRuntimeStatus {
  const requested = env['READYWORK_AGENT_RUNTIME']?.trim().toLowerCase() || 'dsh';
  const model = env['READYWORK_DSH_MODEL']?.trim() || 'deepseek-v4-flash';
  const observed = observation.workerObserved === true;
  try {
    const config = loadAgentRuntimeConfig({ env });
    if (config.kind === 'inmemory') {
      return {
        runtime: 'inmemory', provider: 'inmemory', model: 'inmemory-deterministic', readiness: observed ? 'ready' : 'not_observed',
        isolation: 'in_process', role: 'ai-kernel', default: false, configured: true, available: observed, status: observed ? 'ready' : 'unavailable',
        source: 'temporal-worker-config', observed, configuration: 'valid',
        note: observed ? '已观测到使用内存 Runtime 的 Temporal Worker' : 'Temporal Worker 配置为内存 Runtime；尚未观测到 Task Queue Poller',
      };
    }
    return {
      runtime: 'deepseek-harness', provider: config.runtimeOptions.provider ?? 'deepseek-official', model: config.runtimeOptions.model ?? model,
      readiness: observed ? 'ready' : 'not_observed', isolation: 'subprocess', role: 'ai-kernel', default: requested === 'dsh',
      configured: true, available: observed, status: observed ? 'ready' : 'unavailable', source: 'temporal-worker-config', observed,
      configuration: 'valid', note: observed ? '已观测到通过 DSH 启动预检的 Temporal Worker' : 'Temporal Worker 配置有效；尚未观测到 Task Queue Poller',
    };
  } catch (error) {
    const message = safeError(error, env) ?? `READYWORK_AGENT_RUNTIME=${requested} 配置无效`;
    const isInMemory = requested === 'inmemory';
    // Worker 只有在 Agent Runtime 启动预检成功后才会注册 Task Queue poller。
    // 控制面与 Worker 是独立进程，前者没有 Worker 的私有环境变量并不能推翻已观测的运行事实。
    if (observed) {
      return {
        runtime: isInMemory ? 'inmemory' : 'deepseek-harness', provider: isInMemory ? 'inmemory' : 'deepseek-official',
        model: isInMemory ? 'inmemory-deterministic' : model, readiness: 'ready',
        isolation: isInMemory ? 'in_process' : 'subprocess', role: 'ai-kernel', default: !isInMemory,
        configured: true, available: true, status: 'ready', source: 'temporal-worker-config', observed: true,
        configuration: 'valid',
        note: '已观测到通过 Agent Runtime 启动预检的 Temporal Worker；控制面不读取 Worker 私有配置',
      };
    }
    return {
      runtime: isInMemory ? 'inmemory' : 'deepseek-harness', provider: isInMemory ? 'inmemory' : 'deepseek-official',
      model: isInMemory ? 'inmemory-deterministic' : model, readiness: 'unconfigured',
      isolation: isInMemory ? 'in_process' : 'subprocess', role: 'ai-kernel', default: !isInMemory,
      configured: false, available: false, status: 'unconfigured', source: 'temporal-worker-config', observed: false,
      configuration: 'invalid', error: message,
    };
  }
}
