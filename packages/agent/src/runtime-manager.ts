import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentRequest, AgentResult, AgentRuntimePort } from '@readywork/core';
import { DeepSeekHarnessAdapter, type DeepSeekHarnessAdapterOptions } from './deepseek-harness-adapter.js';
import type { HarnessRuntimeOptions } from './harness-runtime.js';
import { InMemoryAgentAdapter, type InMemoryAgentOptions } from './in-memory-agent-adapter.js';

const DEFAULT_DSH_BIN = 'packages/examples/jsonrpc-demo/src/bin.ts';
const DEFAULT_DSH_CORDIS = fileURLToPath(new URL('../config/decision-only.cordis.yml', import.meta.url));
const LOCAL_MODEL_PLACEHOLDER_KEY = 'readywork-local-model';

export class AgentRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRuntimeConfigError';
  }
}

export type AgentRuntimeKind = 'dsh' | 'inmemory';

export interface DshAgentRuntimeConfig {
  kind: 'dsh';
  repository: string;
  runtimeOptions: HarnessRuntimeOptions;
  /** 仅保留已校验的路由规则；凭据始终复用同一受控 child env。 */
  routing: DshAgentRoutingConfig;
}

export interface InMemoryAgentRuntimeConfig {
  kind: 'inmemory';
}

export type AgentRuntimeConfig = DshAgentRuntimeConfig | InMemoryAgentRuntimeConfig;

export type DshReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface DshAgentProfile {
  model?: string;
  reasoningEffort?: DshReasoningEffort;
  maxTokens?: number;
}

/**
 * 运行时模型预算路由。优先级为 worker > employee > default；只接受服务端环境变量，
 * 不接受任务输入或模型输出中的模型、推理强度和 token 预算，避免请求侧绕过成本控制。
 */
export interface DshAgentRoutingConfig {
  default: Required<DshAgentProfile>;
  employees: Record<string, DshAgentProfile>;
  workers: Record<string, DshAgentProfile>;
}

export interface LoadAgentRuntimeConfigOptions {
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  /** 只用于可重现测试；生产必须使用 READYWORK_DSH_REPO。 */
  legacyDshRepository?: string;
}

/**
 * 从环境构建唯一默认 Agent Runtime 配置。
 *
 * 默认是 DSH；只有显式 READYWORK_AGENT_RUNTIME=inmemory 才使用测试桩。
 * DSH 缺失时直接报错，绝不会静默降级为 InMemory。
 */
export function loadAgentRuntimeConfig(options: LoadAgentRuntimeConfigOptions = {}): AgentRuntimeConfig {
  const env = options.env ?? process.env;
  const kind = (env['READYWORK_AGENT_RUNTIME']?.trim().toLowerCase() || 'dsh') as AgentRuntimeKind;
  if (kind === 'inmemory') return { kind };
  if (kind !== 'dsh') {
    throw new AgentRuntimeConfigError(`READYWORK_AGENT_RUNTIME 仅支持 dsh 或 inmemory，当前为 ${JSON.stringify(kind)}`);
  }

  const configuredRepository = env['READYWORK_DSH_REPO']?.trim() || options.legacyDshRepository?.trim();
  if (!configuredRepository) {
    throw new AgentRuntimeConfigError('DeepSeek Harness 配置缺少 READYWORK_DSH_REPO；如需测试桩，请显式设置 READYWORK_AGENT_RUNTIME=inmemory。');
  }
  const repository = resolve(configuredRepository);
  if (!existsSync(repository)) {
    throw new AgentRuntimeConfigError(`DeepSeek Harness 源目录不存在：${repository}。请设置 READYWORK_DSH_REPO；如需测试桩，请显式设置 READYWORK_AGENT_RUNTIME=inmemory。`);
  }

  const command = env['READYWORK_DSH_COMMAND']?.trim() || process.execPath;
  const cordis = env['READYWORK_DSH_CORDIS']?.trim()
    ? resolveFrom(repository, env['READYWORK_DSH_CORDIS'].trim())
    : DEFAULT_DSH_CORDIS;
  const bin = join(repository, DEFAULT_DSH_BIN);
  const args = env['READYWORK_DSH_ARGS'] ? parseArgs(env['READYWORK_DSH_ARGS']) : ['--import', 'tsx', bin, cordis];
  if (!env['READYWORK_DSH_ARGS']) {
    requirePath(bin, 'DSH JSON-RPC runtime');
    requirePath(cordis, 'DSH Cordis 配置');
  }

  const workspace = resolve(env['READYWORK_DSH_WORKSPACE']?.trim() || options.cwd || process.cwd());
  const sessionRoot = resolveFrom(workspace, env['READYWORK_DSH_SESSION_ROOT']?.trim() || '.readywork/dsh-sessions');
  const childEnv: Record<string, string> = {
    DSH_CWD: workspace,
    DSH_SESSION_ROOT: sessionRoot,
  };
  copyEnv(env, childEnv, 'DEEPSEEK_API_KEY');
  copyEnv(env, childEnv, 'DEEPSEEK_BASE_URL');
  configureModelCredential(childEnv);

  const defaultProfile: Required<DshAgentProfile> = {
    model: requiredModelName(env['READYWORK_DSH_MODEL']?.trim() || 'deepseek-v4-flash', 'READYWORK_DSH_MODEL'),
    reasoningEffort: parseReasoningEffort(env['READYWORK_DSH_REASONING_EFFORT'], 'READYWORK_DSH_REASONING_EFFORT') ?? 'max',
    maxTokens: optionalBoundedPositiveInteger(env, 'READYWORK_DSH_MAX_TOKENS') ?? 4_096,
  };
  const routing = parseAgentRouting(env['READYWORK_DSH_AGENT_PROFILES'], defaultProfile);

  return {
    kind,
    repository,
    routing,
    runtimeOptions: {
      command,
      args,
      cwd: repository,
      env: childEnv,
      inheritedEnvAllowlist: parseEnvAllowlist(env['READYWORK_DSH_ENV_ALLOWLIST']),
      provider: env['READYWORK_DSH_PROVIDER']?.trim() || 'deepseek-official',
      model: routing.default.model,
      maxTokens: routing.default.maxTokens,
      reasoningEffort: routing.default.reasoningEffort,
      initializeTimeoutMs: positiveInteger(env, 'READYWORK_DSH_INITIALIZE_TIMEOUT_MS', 60_000),
      turnTimeoutMs: positiveInteger(env, 'READYWORK_DSH_TURN_TIMEOUT_MS', 180_000),
      requestTimeoutMs: positiveInteger(env, 'READYWORK_DSH_REQUEST_TIMEOUT_MS', 30_000),
    },
  };
}

export interface AgentRuntimeDescription {
  kind: AgentRuntimeKind;
  implementation: 'DeepSeekHarnessAdapter' | 'InMemoryAgentAdapter';
  provider?: string;
  model?: string;
  isolation: 'per_employee_process' | 'in_process';
  timeouts?: { initializeMs: number; turnMs: number; requestMs: number };
  /** Harness 只返回决策，业务副作用仍由 Readywork Runtime 审批、授权并执行。 */
  directBusinessTools: false;
}

export type AgentRuntimeHealthStatus = 'not_started' | 'starting' | 'ready' | 'unhealthy' | 'stopping' | 'closed';

export interface AgentRuntimeHealth {
  status: AgentRuntimeHealthStatus;
  /** 只有已完成启动且当前未处于错误/关闭流程时为 true。 */
  ready: boolean;
  checkedAt: string;
  inFlight: number;
  detail?: string;
}

interface StartableRuntime extends AgentRuntimePort {
  start?: () => Promise<void>;
  close?: () => Promise<void>;
}

export interface AgentRuntimeManagerOptions {
  shutdownTimeoutMs?: number;
  /** 仅用于健康信息脱敏，永远不会出现在 description 中。 */
  redactValues?: string[];
}

/** 统一生命周期边界：预热、执行追踪、无密钥健康状态与安全关闭。 */
export class AgentRuntimeManager implements AgentRuntimePort {
  private health: AgentRuntimeHealth = { status: 'not_started', ready: false, checkedAt: new Date().toISOString(), inFlight: 0 };
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly operations = new Set<Promise<unknown>>();

  constructor(
    private readonly runtime: StartableRuntime,
    private readonly description: AgentRuntimeDescription,
    private readonly options: AgentRuntimeManagerOptions = {},
  ) {}

  getDescription(): AgentRuntimeDescription {
    return structuredClone(this.description);
  }

  getHealth(): AgentRuntimeHealth {
    return { ...this.health, inFlight: this.operations.size };
  }

  async start(): Promise<void> {
    if (this.health.status === 'ready') return;
    if (this.isClosing()) throw new Error('Agent Runtime 正在关闭或已关闭');
    if (this.startPromise) return this.startPromise;
    this.setHealth('starting');
    this.startPromise = (async () => {
      try {
        await this.runtime.start?.();
        if (!this.isClosing()) this.setHealth('ready');
      } catch (error) {
        if (!this.isClosing()) this.setHealth('unhealthy', this.safeError(error));
        throw error;
      } finally {
        this.startPromise = undefined;
      }
    })();
    return this.startPromise;
  }

  async execute(req: AgentRequest): Promise<AgentResult> {
    if (this.isClosing()) throw new Error('Agent Runtime 已停止接收新任务');
    await this.start();
    if (this.isClosing()) throw new Error('Agent Runtime 已停止接收新任务');

    const operation = this.runtime.execute(req);
    this.operations.add(operation);
    try {
      const result = await operation;
      if (!this.isClosing()) this.setHealth('ready');
      return result;
    } catch (error) {
      if (!this.isClosing()) this.setHealth('unhealthy', this.safeError(error));
      throw error;
    } finally {
      this.operations.delete(operation);
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.health.status === 'closed') return;
    this.setHealth('stopping');
    this.closePromise = (async () => {
      try {
        await this.startPromise?.catch(() => {});
        if (this.operations.size > 0) {
          await Promise.race([
            Promise.allSettled([...this.operations]),
            timeout(this.options.shutdownTimeoutMs ?? 10_000),
          ]);
        }
        await this.runtime.close?.();
        this.setHealth('closed');
      } catch (error) {
        this.setHealth('unhealthy', this.safeError(error));
        throw error;
      }
    })();
    return this.closePromise;
  }

  private setHealth(status: AgentRuntimeHealthStatus, detail?: string): void {
    this.health = { status, ready: status === 'ready', checkedAt: new Date().toISOString(), inFlight: this.operations.size, ...(detail ? { detail } : {}) };
  }

  private isClosing(): boolean {
    return this.closePromise !== undefined || this.health.status === 'stopping' || this.health.status === 'closed';
  }

  private safeError(error: unknown): string {
    let value = error instanceof Error ? error.message : String(error);
    for (const secret of this.options.redactValues ?? []) {
      if (secret) value = value.split(secret).join('[REDACTED]');
    }
    return value
      .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .slice(0, 500);
  }
}

export interface CreateDefaultAgentRuntimeOptions extends LoadAgentRuntimeConfigOptions {
  inMemory?: InMemoryAgentOptions;
  dsh?: Pick<DeepSeekHarnessAdapterOptions, 'logger' | 'onEvents' | 'systemPrompt' | 'parseDecision'>;
  shutdownTimeoutMs?: number;
}

export function createDefaultAgentRuntime(options: CreateDefaultAgentRuntimeOptions = {}): AgentRuntimeManager {
  const config = loadAgentRuntimeConfig(options);
  if (config.kind === 'inmemory') {
    return new AgentRuntimeManager(
      new InMemoryAgentAdapter(options.inMemory),
      { kind: 'inmemory', implementation: 'InMemoryAgentAdapter', isolation: 'in_process', directBusinessTools: false },
      { shutdownTimeoutMs: options.shutdownTimeoutMs },
    );
  }

  const rt = config.runtimeOptions;
  const adapter = new DeepSeekHarnessAdapter({
    runtimeOptions: rt,
    runtimeFactory: (employeeId, workerId) => {
      const profile = routeAgentProfile(config.routing, employeeId, workerId);
      return {
        ...rt,
        model: profile.model,
        maxTokens: profile.maxTokens,
        reasoningEffort: profile.reasoningEffort,
        env: {
          ...rt.env,
          READYWORK_DSH_REASONING_EFFORT: profile.reasoningEffort,
          DSH_SESSION_ROOT: employeeSessionRoot(rt.env['DSH_SESSION_ROOT']!, employeeId),
        },
        args: [...rt.args],
        inheritedEnvAllowlist: [...(rt.inheritedEnvAllowlist ?? [])],
      };
    },
    ...options.dsh,
  });
  const secrets = [rt.env['DEEPSEEK_API_KEY'], rt.env['DEEPSEEK_BASE_URL']].filter((v): v is string => Boolean(v));
  return new AgentRuntimeManager(
    adapter,
    {
      kind: 'dsh',
      implementation: 'DeepSeekHarnessAdapter',
      provider: rt.provider,
      model: rt.model,
      isolation: 'per_employee_process',
      timeouts: {
        initializeMs: rt.initializeTimeoutMs ?? 60_000,
        turnMs: rt.turnTimeoutMs ?? 180_000,
        requestMs: rt.requestTimeoutMs ?? 30_000,
      },
      directBusinessTools: false,
    },
    { shutdownTimeoutMs: options.shutdownTimeoutMs, redactValues: secrets },
  );
}

/** Resolve a trusted, server-configured profile. */
export function routeAgentProfile(config: DshAgentRoutingConfig, employeeId: string, workerId: string): Required<DshAgentProfile> {
  const candidate = config.workers[workerId] ?? config.employees[employeeId] ?? {};
  return {
    model: candidate.model ?? config.default.model,
    reasoningEffort: candidate.reasoningEffort ?? config.default.reasoningEffort,
    maxTokens: candidate.maxTokens ?? config.default.maxTokens,
  };
}

function parseAgentRouting(raw: string | undefined, defaultProfile: Required<DshAgentProfile>): DshAgentRoutingConfig {
  const result: DshAgentRoutingConfig = { default: defaultProfile, employees: {}, workers: {} };
  if (!raw?.trim()) return result;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new AgentRuntimeConfigError('READYWORK_DSH_AGENT_PROFILES 必须是 JSON 对象'); }
  if (!isRecord(parsed)) throw new AgentRuntimeConfigError('READYWORK_DSH_AGENT_PROFILES 必须是 JSON 对象');
  for (const key of ['employees', 'workers'] as const) {
    const profiles = parsed[key];
    if (profiles === undefined) continue;
    if (!isRecord(profiles)) throw new AgentRuntimeConfigError(`READYWORK_DSH_AGENT_PROFILES.${key} 必须是对象`);
    for (const [id, value] of Object.entries(profiles)) {
      if (!id.trim() || id.length > 200 || !isRecord(value)) throw new AgentRuntimeConfigError(`READYWORK_DSH_AGENT_PROFILES.${key} 包含无效路由`);
      result[key][id] = parseAgentProfile(value, `READYWORK_DSH_AGENT_PROFILES.${key}.${id}`);
    }
  }
  return result;
}

function parseAgentProfile(value: Record<string, unknown>, label: string): DshAgentProfile {
  for (const key of Object.keys(value)) {
    if (key !== 'model' && key !== 'reasoningEffort' && key !== 'maxTokens') throw new AgentRuntimeConfigError(`${label} 包含不支持字段: ${key}`);
  }
  const profile: DshAgentProfile = {};
  if (value['model'] !== undefined) {
    if (typeof value['model'] !== 'string') throw new AgentRuntimeConfigError(`${label}.model 必须是字符串`);
    profile.model = requiredModelName(value['model'], `${label}.model`);
  }
  if (value['reasoningEffort'] !== undefined) {
    if (typeof value['reasoningEffort'] !== 'string') throw new AgentRuntimeConfigError(`${label}.reasoningEffort 必须是字符串`);
    profile.reasoningEffort = parseReasoningEffort(value['reasoningEffort'], `${label}.reasoningEffort`)!;
  }
  if (value['maxTokens'] !== undefined) {
    if (!Number.isSafeInteger(value['maxTokens']) || (value['maxTokens'] as number) < 128 || (value['maxTokens'] as number) > 131_072) {
      throw new AgentRuntimeConfigError(`${label}.maxTokens 必须是 128-131072 的整数`);
    }
    profile.maxTokens = value['maxTokens'] as number;
  }
  return profile;
}

function requiredModelName(value: string, label: string): string {
  const model = value.trim();
  if (!model || model.length > 200 || !/^[A-Za-z0-9._:/-]+$/.test(model)) throw new AgentRuntimeConfigError(`${label} 必须是有效模型标识`);
  return model;
}

function parseReasoningEffort(raw: string | undefined, label: string): DshReasoningEffort | undefined {
  if (!raw?.trim()) return undefined;
  const effort = raw.trim().toLowerCase();
  if (effort === 'off' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') return effort;
  throw new AgentRuntimeConfigError(`${label} 仅支持 off、low、medium、high 或 max`);
}

function optionalBoundedPositiveInteger(env: Readonly<Record<string, string | undefined>>, key: string): number | undefined {
  const value = optionalPositiveInteger(env, key);
  if (value !== undefined && (value < 128 || value > 131_072)) throw new AgentRuntimeConfigError(`${key} 必须是 128-131072 的整数`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseArgs(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('必须是字符串数组');
    return value;
  } catch (error) {
    const detail = error instanceof Error && error.message === '必须是字符串数组' ? `：${error.message}` : '';
    throw new AgentRuntimeConfigError(`READYWORK_DSH_ARGS 必须是 JSON 字符串数组${detail}`);
  }
}

function parseEnvAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const names = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
  if (!names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new AgentRuntimeConfigError('READYWORK_DSH_ENV_ALLOWLIST 必须是逗号分隔的环境变量名');
  }
  return names;
}

function configureModelCredential(env: Record<string, string>): void {
  const baseUrl = env['DEEPSEEK_BASE_URL'];
  const localBaseUrl = baseUrl ? isLocalModelUrl(baseUrl) : false;
  if (env['DEEPSEEK_API_KEY']) return;
  // DSH 的 DeepSeek adapter 即使请求本地 mock 也要求 Authorization 非空。
  // 这是固定的非秘密占位值，不来自用户配置，也不会授予任何远端服务权限。
  if (localBaseUrl) {
    env['DEEPSEEK_API_KEY'] = LOCAL_MODEL_PLACEHOLDER_KEY;
    return;
  }
  throw new AgentRuntimeConfigError('DeepSeek 模型配置缺少 DEEPSEEK_API_KEY；仅显式 localhost/loopback 的 DEEPSEEK_BASE_URL 可无密钥运行。');
}

function isLocalModelUrl(raw: string): boolean {
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    throw new AgentRuntimeConfigError('DEEPSEEK_BASE_URL 必须是有效 URL');
  }
}

function employeeSessionRoot(root: string, employeeId: string): string {
  const slug = employeeId
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'employee';
  const digest = createHash('sha256').update(employeeId).digest('hex').slice(0, 12);
  return join(resolve(root), `${slug}-${digest}`);
}

function optionalPositiveInteger(env: Readonly<Record<string, string | undefined>>, key: string): number | undefined {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  return parsePositiveInteger(key, raw);
}

function positiveInteger(env: Readonly<Record<string, string | undefined>>, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  return raw ? parsePositiveInteger(key, raw) : fallback;
}

function parsePositiveInteger(key: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new AgentRuntimeConfigError(`${key} 必须是正整数`);
  return value;
}

function copyEnv(source: Readonly<Record<string, string | undefined>>, target: Record<string, string>, key: string): void {
  const value = source[key]?.trim();
  if (value) target[key] = value;
}

function resolveFrom(root: string, value: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

function requirePath(path: string, label: string): void {
  if (!existsSync(path)) throw new AgentRuntimeConfigError(`${label} 不存在：${path}`);
}

function timeout(ms: number): Promise<void> {
  return new Promise((resolveTimeout) => {
    const timer = setTimeout(resolveTimeout, ms);
    timer.unref();
  });
}
